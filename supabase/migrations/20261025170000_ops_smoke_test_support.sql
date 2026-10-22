-- Independent receipt archive (R2): dedicated, structurally-isolated support for the
-- post-deployment production smoke test.
--
-- The smoke test needs to exercise the real worker end-to-end without ever being mistakable for
-- a receipt, counted in receipt-facing metrics, or touchable by reconciliation. Rather than reuse
-- the documents/ prefix with a naming convention alone (which a future accounting export could
-- accidentally match), add a structural flag and keep the test object's path entirely outside
-- documents/ and summaries/ -- reconcile_storage_gaps() only scans 'documents/%' and will never
-- see it; archive.backup_health explicitly excludes it from every receipt-facing count below.

alter table archive.r2_archive_jobs
  add column if not exists is_ops_test boolean not null default false;

comment on column archive.r2_archive_jobs.is_ops_test is
  'True only for the operational smoke-test object (see scripts/receipt-archive/src/'
  'production-smoke-test.js), never for a real receipt or historical PDF. Excluded from every '
  'receipt-facing metric in archive.backup_health.';

create or replace view archive.backup_health as
select
  (select count(*) from archive.document_pdf_versions) as expected_versions,
  (select count(*) from archive.r2_archive_jobs where status = 'completed' and not is_ops_test) as archived_versions,
  (select count(*) from archive.r2_archive_jobs where status = 'pending' and not is_ops_test) as pending_jobs,
  (select count(*) from archive.r2_archive_jobs where status = 'failed' and not is_ops_test) as failed_jobs,
  (select count(*) from archive.r2_archive_jobs where status in ('pending', 'processing', 'failed') and not is_ops_test) as missing_archive_objects,
  (select max(completed_at) from archive.r2_archive_jobs where status = 'completed' and not is_ops_test) as last_successful_archival,
  (select max(finished_at) from archive.reconciliation_runs where kind = 'reconcile' and status = 'completed') as last_reconciliation,
  (select max(finished_at) from archive.reconciliation_runs where kind = 'integrity_verify' and status = 'completed') as last_integrity_verification,
  (select coalesce(sum(size_bytes), 0) from archive.document_pdf_versions) as archive_storage_size_bytes,
  case
    when (select count(*) from archive.r2_archive_jobs where status = 'failed' and not is_ops_test) > 0 then 'critical'
    when (select count(*) from archive.r2_archive_jobs where status in ('pending', 'processing') and not is_ops_test and created_at < now() - interval '1 day') > 0 then 'degraded'
    else 'healthy'
  end as health_status;

comment on view archive.backup_health is
  'Backend metrics for the future manager-only Backup Management screen (not yet built). Every '
  'count explicitly excludes is_ops_test rows -- the operational smoke test never affects '
  'receipt-facing numbers. health_status is critical if any real job has exhausted retries, '
  'degraded if something real has been pending >1 day, else healthy.';

revoke all on archive.backup_health from public, anon, authenticated;
grant select on archive.backup_health to service_role;

-- Dedicated entry point for the smoke test -- archive.r2_archive_jobs stays unreachable via
-- PostgREST (same as every other archive.* function); this is the one, narrow, service_role-only
-- way in, and it always sets is_ops_test = true and document_id = null unconditionally (the
-- caller cannot set it to anything else, so a real receipt can never be queued through this path).
create or replace function public.queue_ops_smoke_test_job(p_storage_path text, p_r2_key text)
returns uuid
language plpgsql
security definer
set search_path = archive, public
as $$
declare
  v_id uuid;
begin
  if p_storage_path is null or p_storage_path !~ '^_ops_smoke_test/' then
    raise exception 'ops_smoke_test_path_must_be_isolated'
      using detail = 'p_storage_path must be under _ops_smoke_test/ -- refusing anything that could resemble a receipt path.';
  end if;

  insert into archive.r2_archive_jobs (storage_path, r2_key, document_id, is_historical, is_ops_test, status)
  values (p_storage_path, p_r2_key, null, false, true, 'pending')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.queue_ops_smoke_test_job(text, text) is
  'The only way to queue an is_ops_test=true job. Rejects any path not under _ops_smoke_test/, so '
  'this entry point structurally cannot be used to queue anything that looks like a receipt.';

revoke execute on function public.queue_ops_smoke_test_job(text, text) from public, anon, authenticated;
grant execute on function public.queue_ops_smoke_test_job(text, text) to service_role;

-- Self-check.
do $$
begin
  if has_function_privilege('authenticated', 'public.queue_ops_smoke_test_job(text, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.queue_ops_smoke_test_job(text, text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: queue_ops_smoke_test_job must stay service_role-only';
  end if;
end $$;
