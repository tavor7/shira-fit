-- Independent receipt archive (R2): job claiming/completion, reconciliation, metrics, and the
-- cron/Edge-Function wiring that drives them.

-- ---------------------------------------------------------------------------
-- 1. Worker RPCs (service_role only -- called by the archive-document-pdf Edge Function using the
--    service key, same access model as every other Storage-touching Edge Function here).
-- ---------------------------------------------------------------------------
create or replace function archive.claim_jobs(p_limit integer default 20, p_worker_id text default null)
returns setof archive.r2_archive_jobs
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  return query
  update archive.r2_archive_jobs j
  set status = 'processing',
      attempts = j.attempts + 1,
      last_attempt_at = now(),
      locked_at = now(),
      locked_by = p_worker_id
  where j.id in (
    select id from archive.r2_archive_jobs
    where (status = 'pending' and next_attempt_at <= now())
       -- stale processing lock (worker crashed mid-job) -- reclaim after 10 minutes.
       or (status = 'processing' and locked_at < now() - interval '10 minutes')
    order by next_attempt_at asc
    limit p_limit
    for update skip locked
  )
  returning j.*;
end;
$$;

comment on function archive.claim_jobs(integer, text) is
  'Concurrency-safe claim (FOR UPDATE SKIP LOCKED) for the archive-document-pdf worker, mirroring '
  'the push-outbox dispatch pattern. Also reclaims jobs stuck in processing for >10 minutes '
  '(worker crash recovery).';

create or replace function archive.complete_job(p_job_id uuid, p_sha256 text)
returns void
language plpgsql
security definer
set search_path = archive, public
as $$
begin
  update archive.r2_archive_jobs
  set status = 'completed', sha256 = p_sha256, verified_at = now(), completed_at = now(),
      last_error = null
  where id = p_job_id;
end;
$$;

create or replace function archive.fail_job(p_job_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = archive, public
as $$
declare
  v_job archive.r2_archive_jobs%rowtype;
  v_backoff_seconds integer;
begin
  select * into v_job from archive.r2_archive_jobs where id = p_job_id for update;
  if not found then return; end if;

  if v_job.attempts >= v_job.max_attempts then
    update archive.r2_archive_jobs
    set status = 'failed', last_error = p_error
    where id = p_job_id;

    -- Only a persistent, retry-exhausted failure is reported -- a single transient failure (R2
    -- hiccup, network blip) just goes back to 'pending' below and is never reported, by design
    -- (Part E: no push for transient failures that recover automatically).
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'receipt_archive',
      p_operation := 'archive_job_failed',
      p_error_class := 'archive_upload_exhausted',
      p_severity := 'critical',
      p_message := p_error,
      p_entities := jsonb_build_object('document_id', v_job.document_id, 'storage_path', v_job.storage_path),
      p_fingerprint_key := 'receipt_archive_job_failed:' || v_job.storage_path
    );
  else
    v_backoff_seconds := least(power(2, v_job.attempts + 1)::integer, 3600);
    update archive.r2_archive_jobs
    set status = 'pending', last_error = p_error, next_attempt_at = now() + (v_backoff_seconds || ' seconds')::interval
    where id = p_job_id;
  end if;
end;
$$;

revoke execute on function archive.claim_jobs(integer, text) from public, anon, authenticated;
revoke execute on function archive.complete_job(uuid, text) from public, anon, authenticated;
revoke execute on function archive.fail_job(uuid, text) from public, anon, authenticated;
grant execute on function archive.claim_jobs(integer, text) to service_role;
grant execute on function archive.complete_job(uuid, text) to service_role;
grant execute on function archive.fail_job(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Reconciliation: pure-SQL gap detection against storage.objects (a real Postgres table, no
--    Storage HTTP call needed for this part). Finds (a) new PDFs under documents/ that have no
--    archive job yet, and (b) queues them. Does NOT touch R2 or re-verify hashes -- that half
--    (actual R2-side checksum verification) runs in the Edge Function, since it needs the R2 API.
-- ---------------------------------------------------------------------------
create or replace function archive.reconcile_storage_gaps()
returns uuid
language plpgsql
security definer
set search_path = archive, public, storage
as $$
declare
  v_run_id uuid;
  v_source_count integer;
  v_newly_queued integer := 0;
  r record;
begin
  insert into archive.reconciliation_runs (kind, status) values ('reconcile', 'running')
  returning id into v_run_id;

  select count(*) into v_source_count
  from storage.objects where bucket_id = 'document-pdfs' and name like 'documents/%';

  for r in
    select o.name as storage_path, o.id as object_id
    from storage.objects o
    where o.bucket_id = 'document-pdfs'
      and o.name like 'documents/%'
      and not exists (select 1 from archive.r2_archive_jobs j where j.storage_path = o.name)
  loop
    insert into archive.r2_archive_jobs (storage_path, r2_key, is_historical, status)
    values (r.storage_path, 'objects/' || r.storage_path, true, 'pending')
    on conflict (storage_path) do nothing;
    v_newly_queued := v_newly_queued + 1;
  end loop;

  update archive.reconciliation_runs
  set finished_at = now(), status = 'completed',
      source_object_count = v_source_count,
      archived_count = (select count(*) from archive.r2_archive_jobs where status = 'completed'),
      missing_count = (select count(*) from archive.r2_archive_jobs where status in ('pending', 'processing', 'failed')),
      newly_queued_count = v_newly_queued
  where id = v_run_id;

  return v_run_id;
end;
$$;

revoke execute on function archive.reconcile_storage_gaps() from public, anon, authenticated;
grant execute on function archive.reconcile_storage_gaps() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Metrics view for the future manager-only Backup Management screen. Deliberately computed
--    from the jobs/versions tables (verified archival state), not from a separately-maintained
--    counter that could drift from reality.
-- ---------------------------------------------------------------------------
create or replace view archive.backup_health as
select
  (select count(*) from archive.document_pdf_versions) as expected_versions,
  (select count(*) from archive.r2_archive_jobs where status = 'completed') as archived_versions,
  (select count(*) from archive.r2_archive_jobs where status = 'pending') as pending_jobs,
  (select count(*) from archive.r2_archive_jobs where status = 'failed') as failed_jobs,
  (select count(*) from archive.r2_archive_jobs where status in ('pending', 'processing', 'failed')) as missing_archive_objects,
  (select max(completed_at) from archive.r2_archive_jobs where status = 'completed') as last_successful_archival,
  (select max(finished_at) from archive.reconciliation_runs where kind = 'reconcile' and status = 'completed') as last_reconciliation,
  (select max(finished_at) from archive.reconciliation_runs where kind = 'integrity_verify' and status = 'completed') as last_integrity_verification,
  (select coalesce(sum(size_bytes), 0) from archive.document_pdf_versions) as archive_storage_size_bytes,
  case
    when (select count(*) from archive.r2_archive_jobs where status = 'failed') > 0 then 'critical'
    when (select count(*) from archive.r2_archive_jobs where status in ('pending', 'processing') and created_at < now() - interval '1 day') > 0 then 'degraded'
    else 'healthy'
  end as health_status;

comment on view archive.backup_health is
  'Backend metrics for the future manager-only Backup Management screen (not yet built). health_status '
  'is critical if any job has exhausted retries, degraded if something has been pending >1 day, else healthy.';

revoke all on archive.backup_health from public, anon, authenticated;
grant select on archive.backup_health to service_role;

-- ---------------------------------------------------------------------------
-- 4. Cron + Edge Function invokers, matching invoke_dispatch_notifications_edge's exact shape
--    (vault secret lookup, silent no-op if missing, Bearer secret header).
--
-- One-time setup (Supabase SQL editor, after deploy):
--   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/archive-document-pdf', 'archive_document_pdf_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'archive_document_pdf_secret');
-- ---------------------------------------------------------------------------
create or replace function public.invoke_archive_worker_edge()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'archive_document_pdf_url' limit 1;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'archive_document_pdf_secret' limit 1;
  if v_url is null or v_secret is null or length(trim(v_url)) < 10 or length(trim(v_secret)) < 4 then
    return;
  end if;
  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || trim(v_secret)),
    body := jsonb_build_object('mode', 'process', 'limit', 20)
  );
end;
$$;

create or replace function public.invoke_archive_reconciliation_edge()
returns void
language plpgsql
security definer
set search_path = public, archive
as $$
declare
  v_url text;
  v_secret text;
begin
  -- Pure-SQL gap detection runs here directly (no Edge Function needed for this half).
  perform archive.reconcile_storage_gaps();

  -- R2-side checksum verification does need the Edge Function (R2 API access).
  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'archive_document_pdf_url' limit 1;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'archive_document_pdf_secret' limit 1;
  if v_url is null or v_secret is null or length(trim(v_url)) < 10 or length(trim(v_secret)) < 4 then
    return;
  end if;
  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || trim(v_secret)),
    body := jsonb_build_object('mode', 'verify', 'limit', 50)
  );
end;
$$;

comment on function public.invoke_archive_worker_edge() is
  'Cron-triggered: processes up to 20 pending archive jobs per run via the archive-document-pdf Edge Function.';
comment on function public.invoke_archive_reconciliation_edge() is
  'Cron-triggered (daily): SQL-side gap detection (new/missed Storage objects) plus an R2-side '
  'checksum verification pass via the Edge Function.';

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'receipt-archive-worker') then
    perform cron.schedule('receipt-archive-worker', '*/5 * * * *', $job$select public.invoke_archive_worker_edge();$job$);
  end if;
  if not exists (select 1 from cron.job where jobname = 'receipt-archive-reconciliation') then
    perform cron.schedule('receipt-archive-reconciliation', '30 2 * * *', $job$select public.invoke_archive_reconciliation_edge();$job$);
  end if;
end $$;

-- Self-check.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'receipt-archive-worker' and schedule = '*/5 * * * *') then
    raise exception 'self-check: receipt-archive-worker cron job missing or misconfigured';
  end if;
  if not exists (select 1 from cron.job where jobname = 'receipt-archive-reconciliation' and schedule = '30 2 * * *') then
    raise exception 'self-check: receipt-archive-reconciliation cron job missing or misconfigured';
  end if;
  if has_function_privilege('authenticated', 'archive.claim_jobs(integer, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'archive.claim_jobs(integer, text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: archive.claim_jobs must stay service_role-only';
  end if;
end $$;
