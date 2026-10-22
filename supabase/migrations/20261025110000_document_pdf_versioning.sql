-- Independent receipt archive (R2): PDF version preservation.
--
-- Closes the gap identified in the audit: generate-document-pdf's regeneration path removes the
-- previous Storage object before uploading the new one (admin.storage.from("document-pdfs")
-- .remove([storagePath]) in the Edge Function, matched by finalize_document_pdf's
-- p_allow_overwrite branch). From here on, every PDF a document ever had gets its own unique,
-- permanent Storage path and an archive.document_pdf_versions row; nothing is ever removed or
-- overwritten again.
--
-- Compatibility: version 1 keeps the existing unsuffixed path ("documents/{id}/{number}.pdf") so
-- none of the 516 currently-active documents (or the already-archived 693 PDFs) need renaming or
-- regeneration. Only version 2+ (a real regeneration/cancellation reissue) gets the new
-- "{number}-v{version}.pdf" suffix. Signed URLs and existing documents.pdf_url values are
-- untouched by this migration -- see backfill below.

alter table public.documents
  add column if not exists pdf_version integer not null default 1;

comment on column public.documents.pdf_version is
  'Current PDF version number for this document. Version 1 keeps the historical unsuffixed path; '
  'version 2+ uses documents/{id}/{document_number}-v{version}.pdf. History of every version lives '
  'in archive.document_pdf_versions (append-only, never updated/deleted).';

-- ---------------------------------------------------------------------------
-- Backfill: give every document that already has a PDF a version-1 history row, using its
-- current pdf_url/signature_hash exactly as-is (no renaming, no regeneration, no hashing here --
-- signature_hash already IS the sha256 of the current PDF bytes, computed by the Edge Function at
-- generation time).
-- ---------------------------------------------------------------------------
insert into archive.document_pdf_versions
  (document_id, document_number, pdf_version, storage_path, sha256, signature_provider, reason, created_at)
select d.id, d.document_number, 1, d.pdf_url, d.signature_hash, d.signature_provider, 'created', d.created_at
from public.documents d
where d.pdf_url is not null
on conflict (storage_path) do nothing;

-- ---------------------------------------------------------------------------
-- Enqueue an archive job for every version-history row that doesn't have one yet (covers both the
-- backfill above and every future insert, via the trigger added at the end of this section).
-- idempotent: unique(storage_path) on both tables means re-running this never double-queues.
-- ---------------------------------------------------------------------------
create or replace function archive._enqueue_archive_job_for_version()
returns trigger
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  insert into archive.r2_archive_jobs (document_version_id, storage_path, r2_key, document_id, document_number, is_historical)
  values (new.id, new.storage_path, 'objects/' || new.storage_path, new.document_id, new.document_number, false)
  on conflict (storage_path) do nothing;
  return new;
end;
$$;

revoke execute on function archive._enqueue_archive_job_for_version() from public, anon, authenticated;

drop trigger if exists document_pdf_versions_enqueue_archive on archive.document_pdf_versions;
create trigger document_pdf_versions_enqueue_archive
  after insert on archive.document_pdf_versions
  for each row execute function archive._enqueue_archive_job_for_version();

-- Backfill jobs for the version-1 rows just inserted above (the trigger only fires for rows
-- inserted after it exists). These are the 516 currently-referenced PDFs -- already archived and
-- SHA-256 verified by the manual historical backfill (scripts/receipt-archive/), so they're
-- inserted directly as 'completed' rather than 'pending': the reconciliation job (next migration)
-- re-verifies this against the real R2/manifest state rather than trusting it blindly.
insert into archive.r2_archive_jobs
  (document_version_id, storage_path, r2_key, document_id, document_number, is_historical, status, sha256, verified_at, completed_at)
select v.id, v.storage_path, 'objects/' || v.storage_path, v.document_id, v.document_number, false,
       'completed', v.sha256, now(), now()
from archive.document_pdf_versions v
where v.pdf_version = 1
on conflict (storage_path) do nothing;

-- ---------------------------------------------------------------------------
-- Version allocation + finalize, rewritten to never overwrite.
-- ---------------------------------------------------------------------------
create or replace function public.allocate_document_pdf_version(p_document_id uuid)
returns json
language plpgsql security definer set search_path = public, archive
as $$
declare
  v_doc public.documents%rowtype;
  v_next_version integer;
  v_path text;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  v_next_version := coalesce((select max(pdf_version) from archive.document_pdf_versions where document_id = p_document_id), 0) + 1;
  v_path := case when v_next_version = 1
    then 'documents/' || p_document_id::text || '/' || v_doc.document_number || '.pdf'
    else 'documents/' || p_document_id::text || '/' || v_doc.document_number || '-v' || v_next_version || '.pdf'
  end;

  return json_build_object('ok', true, 'document_id', p_document_id, 'next_version', v_next_version, 'next_pdf_path', v_path);
end;
$$;

comment on function public.allocate_document_pdf_version(uuid) is
  'Previews the next PDF version number/path for a document. Advisory only -- finalize_document_pdf '
  're-derives the authoritative version under its own row lock, so a race between two concurrent '
  'regenerations is resolved there (the loser gets a version_conflict error and must retry), never '
  'by trusting this preview.';

create or replace function public.finalize_document_pdf(
  p_document_id uuid, p_pdf_path text, p_signature_hash text,
  p_signature_provider text default null, p_allow_overwrite boolean default false
)
returns json
language plpgsql security definer set search_path = public, archive
as $$
declare
  v_doc public.documents%rowtype;
  v_next_version integer;
  v_expected_path text;
  v_reason text;
begin
  -- p_allow_overwrite is accepted for call-signature compatibility only and is no longer used:
  -- overwriting is categorically impossible now -- finalize always allocates a new, unique path.
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  v_next_version := coalesce((select max(pdf_version) from archive.document_pdf_versions where document_id = p_document_id), 0) + 1;
  v_reason := case
    when v_next_version = 1 then 'created'
    when v_doc.status = 'CANCELLED' then 'cancelled_reissue'
    else 'regenerated'
  end;
  v_expected_path := case when v_next_version = 1
    then 'documents/' || p_document_id::text || '/' || v_doc.document_number || '.pdf'
    else 'documents/' || p_document_id::text || '/' || v_doc.document_number || '-v' || v_next_version || '.pdf'
  end;

  if p_pdf_path is distinct from v_expected_path then
    -- Another regeneration finalized between this caller's allocate_document_pdf_version() call
    -- and now. Nothing was overwritten (the path they uploaded to was never reused), so the only
    -- side effect is a wasted upload to an unreferenced path -- safe to ask the caller to retry.
    return json_build_object('ok', false, 'error', 'version_conflict', 'expected_path', v_expected_path, 'expected_version', v_next_version);
  end if;

  insert into archive.document_pdf_versions
    (document_id, document_number, pdf_version, storage_path, sha256, signature_provider, reason, created_by)
  values (p_document_id, v_doc.document_number, v_next_version, p_pdf_path, p_signature_hash, p_signature_provider, v_reason, auth.uid());

  update public.documents set
    pdf_url = p_pdf_path,
    pdf_version = v_next_version,
    signature_hash = p_signature_hash,
    signature_provider = p_signature_provider,
    signed_at = case when p_signature_provider is not null then now() else signed_at end
  where id = p_document_id;

  return json_build_object('ok', true, 'document_id', p_document_id, 'pdf_url', p_pdf_path, 'pdf_version', v_next_version);
end;
$$;

-- prepare_document_pdf_regeneration no longer nulls pdf_url/signature_hash/signature_provider/
-- signed_at: the current PDF (and its Storage object) stay valid and retrievable for the entire
-- regeneration window, right up until finalize_document_pdf records the new version. This is a
-- deliberate behavior change from the old contract (which briefly left pdf_url null) -- see the
-- rollout report for the one client-visible implication (any UI that treated "pdf_url is null" as
-- an in-progress-regeneration signal should instead key off the RPC response, not re-reading
-- documents.pdf_url).
create or replace function public.prepare_document_pdf_regeneration(p_document_id uuid)
returns json
language plpgsql security definer set search_path = public, archive
as $$
declare
  v_doc public.documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_next_version integer;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  if v_settings.is_operational then return json_build_object('ok', false, 'error', 'operational_mode_locked'); end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status = 'NEEDS_PAYMENT_METHOD' then return json_build_object('ok', false, 'error', 'needs_payment_method'); end if;

  v_next_version := coalesce((select max(pdf_version) from archive.document_pdf_versions where document_id = p_document_id), 0) + 1;

  perform public._log_document_event(p_document_id, 'document_pdf_regenerated', jsonb_build_object('next_version', v_next_version));

  return json_build_object(
    'ok', true, 'document_id', p_document_id, 'allow_overwrite', true,
    'next_version', v_next_version,
    'next_pdf_path', case when v_next_version = 1
      then 'documents/' || p_document_id::text || '/' || v_doc.document_number || '.pdf'
      else 'documents/' || p_document_id::text || '/' || v_doc.document_number || '-v' || v_next_version || '.pdf'
    end
  );
end;
$$;

revoke execute on function public.allocate_document_pdf_version(uuid) from public, anon;
grant execute on function public.allocate_document_pdf_version(uuid) to authenticated;

-- Self-check.
do $$
declare v_unversioned_active_docs integer;
begin
  select count(*) into v_unversioned_active_docs
  from public.documents d
  where d.pdf_url is not null
    and not exists (select 1 from archive.document_pdf_versions v where v.document_id = d.id and v.pdf_version = 1);
  if v_unversioned_active_docs > 0 then
    raise exception 'self-check: % document(s) with a pdf_url have no version-1 history row', v_unversioned_active_docs;
  end if;

  if exists (
    select 1 from public.documents d
    join archive.document_pdf_versions v1 on v1.document_id = d.id and v1.pdf_version = 1
    where d.pdf_url is not null and d.pdf_url <> v1.storage_path
  ) then
    raise exception 'self-check: a document.pdf_url does not match its own version-1 storage_path';
  end if;
end $$;
