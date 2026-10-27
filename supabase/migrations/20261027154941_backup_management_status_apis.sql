-- Backup Management, Phase 4 + 5: manager-only read APIs for financial backup status and
-- receipt archive health.
--
-- Financial backups (scripts/financial-backup) live entirely in R2 -- Postgres has never stored
-- anything about them, and the mobile app has no R2 credentials (nor should it: see that
-- project's README on credential isolation). Rather than have the client talk to R2 directly or
-- do a live R2 listing in the request path (an unreliable network round-trip for a mobile client,
-- and it would need R2 credentials), the financial-backup GitHub Actions workflow's existing
-- health-check steps (src/health.js, already run read-only against R2 with reader credentials
-- only) will upsert their own JSON output into the new singleton table below via a service_role-
-- only RPC. This migration adds that table + RPC, plus the manager-only read RPC the mobile app
-- calls -- but does NOT yet wire the workflow's write step (that needs a new Supabase service_role
-- credential in GitHub Actions secrets, which is a new production credential grant and is called
-- out separately for review, not added here).
--
-- Receipt archive health (archive.* schema, 20261025100000) already lives in Postgres -- this adds
-- the manager-only aggregate RPC that schema's own comment said would come later ("A future
-- manager-only Backup Management screen will read through a dedicated RPC (not direct table
-- access)").

-- ---------------------------------------------------------------------------------------------
-- Phase 4: financial backup health snapshot (singleton row, service_role write / manager read).
-- ---------------------------------------------------------------------------------------------
create table public.financial_backup_health_snapshot (
  id boolean primary key default true check (id = true), -- singleton row, same idiom as other
                                                           -- one-row settings tables in this codebase
  computed_at timestamptz not null,
  health jsonb not null,
  runs jsonb not null
);

comment on table public.financial_backup_health_snapshot is
  'Singleton cache of scripts/financial-backup/src/health.js''s own output (same shape: health + '
  'runs), upserted by the financial-backup GitHub Actions workflow''s health-check step via '
  'financial_backup_record_health_snapshot() (service_role only). Postgres is NOT the source of '
  'truth for backups -- the actual backup/manifest/verification/restore-test records live in R2 '
  'only. This table exists purely so the manager-only Backup Management screen can read a recent '
  'snapshot from Postgres instead of needing R2 credentials or a live R2 listing.';

alter table public.financial_backup_health_snapshot enable row level security;
revoke all on table public.financial_backup_health_snapshot from public, anon, authenticated;
grant select, insert, update on table public.financial_backup_health_snapshot to service_role;
-- No policies -- RLS enabled with zero policies + no grants to anon/authenticated means those
-- roles have no path to this table at all, same "belt and suspenders" idiom as the archive schema.

create or replace function public.financial_backup_record_health_snapshot(p_health jsonb, p_runs jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.financial_backup_health_snapshot (id, computed_at, health, runs)
  values (true, now(), p_health, p_runs)
  on conflict (id) do update set
    computed_at = excluded.computed_at,
    health = excluded.health,
    runs = excluded.runs;
$$;

comment on function public.financial_backup_record_health_snapshot(jsonb, jsonb) is
  'Service-role-only. Upserts the singleton financial_backup_health_snapshot row. Called by the '
  'financial-backup GitHub Actions workflow right after it computes health.js''s own output -- not '
  'callable by any client role.';

revoke execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb) to service_role;

create or replace function public.manager_get_backup_health()
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snap public.financial_backup_health_snapshot;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_snap from public.financial_backup_health_snapshot where id = true;
  if not found then
    return json_build_object('ok', true, 'has_data', false);
  end if;

  return json_build_object(
    'ok', true,
    'has_data', true,
    'computed_at', v_snap.computed_at,
    'health', v_snap.health,
    'runs', v_snap.runs
  );
end;
$$;

comment on function public.manager_get_backup_health() is
  'Manager-only. Returns the most recent financial-backup health snapshot (see '
  'financial_backup_health_snapshot) as {ok, has_data, computed_at?, health?, runs?}. '
  '{ok:false, error:''forbidden''} for a non-manager.';

revoke execute on function public.manager_get_backup_health() from public, anon;
grant execute on function public.manager_get_backup_health() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Phase 5: receipt archive health -- manager-only aggregate read over archive.* (service_role-
-- only tables; this is the dedicated RPC 20261025100000 said would be added later).
-- ---------------------------------------------------------------------------------------------
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
  v_total_size bigint;
  v_version_count integer;
  v_last_reconcile archive.reconciliation_runs;
  v_last_integrity archive.reconciliation_runs;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- is_ops_test rows (the post-deployment smoke-test object, 20261025170000) are structurally
  -- never a real receipt (queue_ops_smoke_test_job is the only way to create one, and it always
  -- sets document_id=null, is_historical=false) -- excluded from every count here, same
  -- discipline as the existing archive.backup_health view.
  select count(*) into v_total_real from archive.r2_archive_jobs where is_historical = false and not is_ops_test;
  select count(*) into v_archived from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'completed';
  select count(*) into v_pending from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status in ('pending', 'processing');
  select count(*) into v_failed from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'failed';
  select count(*) into v_verified from archive.r2_archive_jobs where not is_ops_test and hash_verified = true;
  select count(*) into v_hash_mismatch from archive.r2_archive_jobs where not is_ops_test and hash_verified = false;
  select coalesce(sum(size_bytes), 0) into v_total_size from archive.document_pdf_versions;
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
    'coverage_pct', case when v_total_real > 0 then round(100.0 * v_archived / v_total_real, 1) else null end,
    'hash_verified_count', v_verified,
    'hash_mismatch_count', v_hash_mismatch,
    'total_pdf_version_count', v_version_count,
    'total_size_bytes', v_total_size,
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
  'Manager-only. Read-only aggregate over archive.* (coverage %, verification/hash-mismatch '
  'counts, total PDF-version count/size, last reconciliation + last integrity-verification runs). '
  '{ok:false, error:''forbidden''} for a non-manager. Never grants broader archive schema access -- '
  'reads happen inside this SECURITY DEFINER function only.';

revoke execute on function public.manager_get_archive_health() from public, anon;
grant execute on function public.manager_get_archive_health() to authenticated;

-- Self-check.
do $$
begin
  if has_function_privilege('anon', 'public.manager_get_backup_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_backup_health must not be callable by anon';
  end if;
  if has_function_privilege('anon', 'public.manager_get_archive_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_archive_health must not be callable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.manager_get_backup_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_backup_health missing EXECUTE for authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.manager_get_archive_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_archive_health missing EXECUTE for authenticated';
  end if;
  if has_function_privilege('authenticated', 'public.financial_backup_record_health_snapshot(jsonb,jsonb)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.financial_backup_record_health_snapshot(jsonb,jsonb)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: financial_backup_record_health_snapshot must stay service_role-only';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'financial_backup_health_snapshot'
      and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'self-check: financial_backup_health_snapshot must not be reachable by anon/authenticated/public';
  end if;
end $$;
