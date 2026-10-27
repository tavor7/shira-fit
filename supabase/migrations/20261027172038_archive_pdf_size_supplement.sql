-- Backup Management: historical PDF size metadata via a SEPARATE, insert-once supplementary
-- table -- NOT by updating archive.document_pdf_versions.
--
-- The first approach (public.record_pdf_size / archive.record_pdf_size, 20261027190000) tried to
-- UPDATE document_pdf_versions.size_bytes directly and was correctly rejected in production by
-- that table's own document_pdf_versions_immutable trigger (confirmed live: zero rows were
-- modified). document_pdf_versions_immutable is left EXACTLY as it is -- this migration never
-- touches it, and the old (now-dead, never-successfully-used) archive.record_pdf_size /
-- public.record_pdf_size_for_worker functions from 20261027190000 are left in place unused
-- rather than removed, same "leave harmless dead code" policy as this session's other overloads.
--
-- New design: archive.document_pdf_version_sizes is its OWN table, linked to
-- document_pdf_versions by version_id (primary key = foreign key -- structurally at most one size
-- record per version, enforced by the database, not application logic). It is itself insert-once
-- (its own immutability trigger rejects every UPDATE/DELETE unconditionally -- simpler than
-- document_pdf_versions_immutable's job, since this table never needs an exception at all: a
-- conflicting re-registration is handled by record_pdf_size_supplement's own conflict check
-- below, not by ever allowing a real UPDATE).
create table archive.document_pdf_version_sizes (
  version_id uuid primary key references archive.document_pdf_versions(id),
  size_bytes bigint not null check (size_bytes >= 0),
  recorded_at timestamptz not null default now()
);

comment on table archive.document_pdf_version_sizes is
  'Supplementary, insert-once size metadata for historical archive.document_pdf_versions rows '
  'whose own size_bytes is NULL (recorded before that column existed/was populated). Never '
  'updates or replaces anything on document_pdf_versions itself -- that table and its '
  'immutability trigger are completely untouched by this design. version_id is both the primary '
  'key and a foreign key, so at most one size record can ever exist per version, enforced by the '
  'database. manager_get_archive_health() treats document_pdf_versions.size_bytes as primary when '
  'present, falling back to this table only when it is NULL -- a row is never counted from both, '
  'so the total is never double-counted.';

create or replace function archive._reject_size_supplement_mutation()
returns trigger
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  raise exception 'archive_size_supplement_immutable'
    using errcode = 'P0001',
          detail = 'archive.document_pdf_version_sizes rows are insert-once and can never be updated or deleted.';
  return old;
end;
$$;

revoke execute on function archive._reject_size_supplement_mutation() from public, anon, authenticated;

create trigger document_pdf_version_sizes_immutable
  before update or delete on archive.document_pdf_version_sizes
  for each row execute function archive._reject_size_supplement_mutation();

alter table archive.document_pdf_version_sizes enable row level security;
revoke all on table archive.document_pdf_version_sizes from public, anon, authenticated;
-- The archive schema has a default ACL (`ALTER DEFAULT PRIVILEGES IN SCHEMA archive ... GRANT ALL
-- ON TABLES TO service_role`) that grants service_role full rights on every new table at CREATE
-- time -- confirmed live via pg_default_acl. That's the right default for tables like
-- r2_archive_jobs which service_role genuinely updates. This table is the exception: it must stay
-- insert-once even for service_role, so explicitly strip UPDATE/DELETE back off before granting
-- only what's needed (belt-and-suspenders alongside the trigger above: even a future bug that
-- bypassed the trigger would still be refused by the grants).
revoke update, delete on table archive.document_pdf_version_sizes from service_role;
grant select, insert on table archive.document_pdf_version_sizes to service_role;

-- Insert-once with explicit conflict handling -- a duplicate registration with the SAME size is a
-- silent, harmless no-op (idempotent retries must never error); a duplicate registration with a
-- DIFFERENT size is never written over the existing value, and is reported to System Issues
-- (severity 'error', never 'critical' -- no push) as something worth a human looking at, since
-- the underlying R2 object's size apparently changed, which shouldn't happen under Bucket Lock.
create or replace function archive.record_pdf_size_supplement(p_version_id uuid, p_size_bytes bigint)
returns void
language plpgsql
security definer
set search_path = archive, public
as $$
declare
  v_existing bigint;
begin
  select size_bytes into v_existing from archive.document_pdf_version_sizes where version_id = p_version_id;
  if found then
    if v_existing is distinct from p_size_bytes then
      perform public._report_system_error(
        p_source := 'trusted',
        p_subsystem := 'receipt_archive',
        p_operation := 'size_backfill',
        p_error_class := 'size_conflict',
        p_severity := 'error',
        p_message := format('Conflicting size for archive version %s: already recorded %s, new HEAD reported %s.', p_version_id, v_existing, p_size_bytes),
        p_entities := jsonb_build_object('version_id', p_version_id, 'recorded_size_bytes', v_existing, 'new_size_bytes', p_size_bytes),
        p_fingerprint_key := 'receipt_archive_size_conflict:' || p_version_id::text
      );
    end if;
    return; -- never overwrites, whether the conflict was real or just a harmless identical retry
  end if;

  insert into archive.document_pdf_version_sizes (version_id, size_bytes) values (p_version_id, p_size_bytes);
end;
$$;

comment on function archive.record_pdf_size_supplement(uuid, bigint) is
  'Insert-once: a first call for a version_id records its size; every later call is a no-op (same '
  'value = harmless idempotent retry; different value = reported to System Issues, never '
  'overwritten). version_id''s foreign key to document_pdf_versions means this can never register '
  'a size for a nonexistent or mismatched record.';

-- Only ever considers a version "still needing a size" if BOTH document_pdf_versions.size_bytes
-- is NULL AND no supplementary row exists yet -- naturally resumable, no separate cursor state,
-- and a version whose real size_bytes gets populated some other way (e.g. a future direct write)
-- is correctly never picked here either.
create or replace function archive.pick_missing_size_candidates(p_limit integer default 200)
returns table (version_id uuid, r2_key text)
language sql
security definer
set search_path = archive, public
as $$
  select dpv.id, raj.r2_key
  from archive.document_pdf_versions dpv
  join archive.r2_archive_jobs raj on raj.document_version_id = dpv.id
  where dpv.size_bytes is null
    and not exists (select 1 from archive.document_pdf_version_sizes s where s.version_id = dpv.id)
    and raj.status = 'completed'
    and not raj.is_ops_test
  order by dpv.created_at asc
  limit p_limit;
$$;

create or replace function public.pick_missing_size_candidates_for_worker(p_limit integer default 200)
returns table (version_id uuid, r2_key text)
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.pick_missing_size_candidates(p_limit);
$$;

create or replace function public.record_pdf_size_supplement_for_worker(p_version_id uuid, p_size_bytes bigint)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.record_pdf_size_supplement(p_version_id, p_size_bytes);
$$;

revoke execute on function archive.record_pdf_size_supplement(uuid, bigint) from public, anon, authenticated;
revoke execute on function archive.pick_missing_size_candidates(integer) from public, anon, authenticated;
revoke execute on function public.pick_missing_size_candidates_for_worker(integer) from public, anon, authenticated;
revoke execute on function public.record_pdf_size_supplement_for_worker(uuid, bigint) from public, anon, authenticated;
grant execute on function archive.record_pdf_size_supplement(uuid, bigint) to service_role;
grant execute on function archive.pick_missing_size_candidates(integer) to service_role;
grant execute on function public.pick_missing_size_candidates_for_worker(integer) to service_role;
grant execute on function public.record_pdf_size_supplement_for_worker(uuid, bigint) to service_role;

-- manager_get_archive_health(): size_bytes is primary when present, the supplement only fills in
-- where it's NULL -- a row contributes at most once to the total either way, never double-counted.
create or replace function public.manager_get_archive_health()
returns json
language plpgsql
security definer
set search_path = public, archive, pg_temp
as $$
declare
  v_total_real integer;
  v_archived integer;
  v_pending integer;
  v_failed integer;
  v_verified integer;
  v_hash_mismatch integer;
  v_never_checked integer;
  v_total_size bigint;
  v_size_known_count integer;
  v_size_unknown_count integer;
  v_version_count integer;
  v_last_reconcile archive.reconciliation_runs;
  v_last_integrity archive.reconciliation_runs;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select count(*) into v_total_real from archive.r2_archive_jobs where is_historical = false and not is_ops_test;
  select count(*) into v_archived from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'completed';
  select count(*) into v_pending from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status in ('pending', 'processing');
  select count(*) into v_failed from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'failed';
  select count(*) into v_verified from archive.r2_archive_jobs where not is_ops_test and hash_verified = true;
  select count(*) into v_hash_mismatch from archive.r2_archive_jobs where not is_ops_test and hash_verified = false;
  v_never_checked := greatest(v_archived - v_verified - v_hash_mismatch, 0);

  select
    count(*) filter (where coalesce(dpv.size_bytes, sup.size_bytes) is not null),
    count(*) filter (where coalesce(dpv.size_bytes, sup.size_bytes) is null),
    sum(coalesce(dpv.size_bytes, sup.size_bytes))
  into v_size_known_count, v_size_unknown_count, v_total_size
  from archive.document_pdf_versions dpv
  left join archive.document_pdf_version_sizes sup on sup.version_id = dpv.id;

  select count(*) into v_version_count from archive.document_pdf_versions;

  select * into v_last_reconcile from archive.reconciliation_runs
  where kind = 'reconcile' order by started_at desc limit 1;
  select * into v_last_integrity from archive.reconciliation_runs
  where kind = 'integrity_verify' order by started_at desc limit 1;

  return json_build_object(
    'ok', true,
    'total_real_documents', v_total_real,
    'archived_count', v_archived,
    'pending_count', v_pending,
    'failed_count', v_failed,
    'upload_coverage_pct', case when v_total_real > 0 then round(100.0 * v_archived / v_total_real, 1) else null end,
    'hash_verified_count', v_verified,
    'hash_mismatch_count', v_hash_mismatch,
    'never_integrity_checked_count', v_never_checked,
    'integrity_checked_pct', case when v_archived > 0 then round(100.0 * (v_verified + v_hash_mismatch) / v_archived, 1) else null end,
    'total_pdf_version_count', v_version_count,
    'total_size_bytes', case when v_size_known_count = 0 then null else v_total_size end,
    'size_unknown_count', v_size_unknown_count,
    'last_reconciliation', case when v_last_reconcile.id is null then null else json_build_object(
      'started_at', v_last_reconcile.started_at,
      'finished_at', v_last_reconcile.finished_at,
      'status', v_last_reconcile.status,
      'missing_count', v_last_reconcile.missing_count,
      'newly_queued_count', v_last_reconcile.newly_queued_count
    ) end,
    'last_integrity_verification', case when v_last_integrity.id is null then null else json_build_object(
      'started_at', v_last_integrity.started_at,
      'finished_at', v_last_integrity.finished_at,
      'status', v_last_integrity.status,
      'hash_mismatch_count', v_last_integrity.hash_mismatch_count,
      'expected_count', v_last_integrity.expected_count
    ) end
  );
end;
$$;

comment on function public.manager_get_archive_health() is
  'Manager-only. Read-only aggregate over archive.* -- total_size_bytes/size_unknown_count use '
  'document_pdf_versions.size_bytes as primary, falling back to the insert-once '
  'document_pdf_version_sizes supplement only where that is NULL; a row is never counted twice. '
  '{ok:false, error:''forbidden''} for a non-manager.';

revoke execute on function public.manager_get_archive_health() from public, anon;
grant execute on function public.manager_get_archive_health() to authenticated;

do $$
begin
  if has_function_privilege('authenticated', 'archive.record_pdf_size_supplement(uuid,bigint)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'archive.record_pdf_size_supplement(uuid,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: archive.record_pdf_size_supplement must stay service_role-only';
  end if;
  if has_function_privilege('authenticated', 'public.record_pdf_size_supplement_for_worker(uuid,bigint)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.record_pdf_size_supplement_for_worker(uuid,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: public.record_pdf_size_supplement_for_worker must stay service_role-only';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'archive' and table_name = 'document_pdf_version_sizes'
      and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'self-check: archive.document_pdf_version_sizes must not be reachable by anon/authenticated/public';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'archive' and table_name = 'document_pdf_version_sizes'
      and grantee = 'service_role' and privilege_type in ('UPDATE', 'DELETE')
  ) then
    raise exception 'self-check: service_role must not have UPDATE/DELETE on archive.document_pdf_version_sizes, even as a backstop alongside the trigger';
  end if;
  if has_function_privilege('anon', 'public.manager_get_archive_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_archive_health must not be callable by anon';
  end if;
end $$;
