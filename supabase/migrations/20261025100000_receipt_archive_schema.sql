-- Independent receipt archive (R2): core schema.
--
-- Context: a read-only production audit found that generate-document-pdf's regeneration path
-- (prepare_document_pdf_regeneration + finalize_document_pdf with p_allow_overwrite) physically
-- overwrites/removes the previous PDF object in Supabase Storage with no history kept, and that
-- no independent backup of document-pdfs exists outside Supabase. A manual historical archive of
-- all 693 existing objects (516 referenced + 177 historical/orphaned) to an isolated Cloudflare R2
-- bucket (shirafit-receipt-archive, indefinite Bucket Lock, verified anti-overwrite/anti-delete)
-- has already been completed and independently SHA-256 verified -- see scripts/receipt-archive/.
--
-- This migration adds the schema for (a) an append-only PDF-version history per document (closing
-- the overwrite gap at the DB level, not just via application discipline) and (b) a durable job
-- queue that an Edge Function worker claims to upload new/changed PDFs to that same R2 bucket.
-- Additive only -- no existing table, column, or function is altered by this file.

create schema if not exists archive;

revoke all on schema archive from public, anon, authenticated;
grant usage on schema archive to service_role;

-- ---------------------------------------------------------------------------
-- 1. Append-only PDF version history for `documents`.
--
-- One row per PDF ever issued for a document (version 1 = the PDF the document was created with,
-- or already had before this migration; version 2+ = a regeneration). Rows are never updated or
-- deleted -- enforced below by the same hard-delete-guard pattern used for documents/document_events
-- (20261023190000_guard_document_hard_delete.sql).
-- ---------------------------------------------------------------------------
create table archive.document_pdf_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id),
  document_number text not null,
  pdf_version integer not null check (pdf_version > 0),
  storage_path text not null unique,
  sha256 text,
  size_bytes bigint,
  signature_provider text,
  reason text not null check (reason in ('created', 'regenerated', 'cancelled_reissue')),
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (document_id, pdf_version)
);

comment on table archive.document_pdf_versions is
  'Append-only history of every PDF object ever issued for a document.storage_path. Replaces the old '
  'behavior where regeneration overwrote/removed the previous Storage object with no record kept. '
  'Never updated or deleted -- see archive guard triggers below.';

create index document_pdf_versions_document_id_idx on archive.document_pdf_versions(document_id);

-- ---------------------------------------------------------------------------
-- 2. Durable archival job queue (Supabase -> R2).
--
-- One row per (document_pdf_versions row OR historical/orphaned Storage object) that needs to
-- exist, verified by content hash, in the R2 archive. Not 1:1 with document_pdf_versions: the 177
-- historical/orphaned objects from the manual backfill have no live document_pdf_versions row
-- (they predate this migration and, in several cases, no longer correspond to any document's
-- *current* pdf_url) but are represented here so reconciliation has one source of truth for
-- "is everything in Storage represented in the archive."
-- ---------------------------------------------------------------------------
create table archive.r2_archive_jobs (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid references archive.document_pdf_versions(id),
  storage_path text not null unique,
  r2_key text not null unique,
  document_id uuid references public.documents(id),
  document_number text,
  is_historical boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  last_error text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  sha256 text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table archive.r2_archive_jobs is
  'Durable queue claimed by the archive-document-pdf Edge Function worker. status/attempts/'
  'next_attempt_at/locked_at implement concurrency-safe claiming with exponential backoff, '
  'mirroring system_issue_push_outbox''s claim pattern (FOR UPDATE SKIP LOCKED).';

create index r2_archive_jobs_claim_idx on archive.r2_archive_jobs(status, next_attempt_at)
  where status in ('pending', 'processing');
create index r2_archive_jobs_document_id_idx on archive.r2_archive_jobs(document_id);

-- ---------------------------------------------------------------------------
-- 3. Reconciliation run log -- also backs the "last_reconciliation" /
--    "last_integrity_verification" metrics needed for the future Backup Management screen.
-- ---------------------------------------------------------------------------
create table archive.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('reconcile', 'integrity_verify')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source_object_count integer,
  expected_count integer,
  archived_count integer,
  missing_count integer,
  hash_mismatch_count integer,
  newly_queued_count integer,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  error text
);

comment on table archive.reconciliation_runs is
  'One row per scheduled reconciliation or integrity-verification pass. Drives the '
  'last_reconciliation / last_integrity_verification backup-health metrics.';

-- ---------------------------------------------------------------------------
-- 4. Append-only guards (same pattern as documents/document_events).
-- ---------------------------------------------------------------------------
create or replace function archive._reject_archive_hard_mutation()
returns trigger
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  raise exception 'archive_record_immutable'
    using errcode = 'P0001',
          detail = format('Rows in %I are append-only archive history and cannot be updated or deleted directly.', tg_table_name);
  return old;
end;
$$;

revoke execute on function archive._reject_archive_hard_mutation() from public, anon, authenticated;

drop trigger if exists document_pdf_versions_immutable on archive.document_pdf_versions;
create trigger document_pdf_versions_immutable
  before update or delete on archive.document_pdf_versions
  for each row execute function archive._reject_archive_hard_mutation();

-- r2_archive_jobs rows ARE mutated (status/attempts/etc. by the worker) -- only hard DELETE is
-- blocked, never UPDATE.
create or replace function archive._reject_archive_job_delete()
returns trigger
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  raise exception 'archive_job_record_immutable'
    using errcode = 'P0001',
          detail = 'archive.r2_archive_jobs rows are never hard-deleted, only transitioned between status values.';
  return old;
end;
$$;

revoke execute on function archive._reject_archive_job_delete() from public, anon, authenticated;

drop trigger if exists r2_archive_jobs_no_delete on archive.r2_archive_jobs;
create trigger r2_archive_jobs_no_delete
  before delete on archive.r2_archive_jobs
  for each row execute function archive._reject_archive_job_delete();

-- ---------------------------------------------------------------------------
-- 5. Access: service_role only (Edge Function worker + reconciliation job use the service key,
--    same as every other Storage-touching Edge Function in this codebase). No anon/authenticated
--    grants at all -- this schema is backend-only infrastructure, not a client-facing API surface.
--    A future manager-only Backup Management screen will read through a dedicated RPC (not direct
--    table access), added when that screen is built.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema archive from public, anon, authenticated;
grant all on all tables in schema archive to service_role;
alter default privileges in schema archive revoke all on tables from public, anon, authenticated;
alter default privileges in schema archive grant all on tables to service_role;

alter table archive.document_pdf_versions enable row level security;
alter table archive.r2_archive_jobs enable row level security;
alter table archive.reconciliation_runs enable row level security;
-- No policies: RLS enabled with zero policies + no grants to anon/authenticated means those
-- roles have no path to this schema at all (same "belt and suspenders" as other internal tables).

-- Self-check.
do $$
begin
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'archive' and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'self-check: archive schema must not be reachable by anon/authenticated/public';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'document_pdf_versions' and t.tgname = 'document_pdf_versions_immutable'
  ) then
    raise exception 'self-check: document_pdf_versions_immutable trigger missing';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'r2_archive_jobs' and t.tgname = 'r2_archive_jobs_no_delete'
  ) then
    raise exception 'self-check: r2_archive_jobs_no_delete trigger missing';
  end if;
end $$;
