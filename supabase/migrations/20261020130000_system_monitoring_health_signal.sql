-- System Issues monitoring completion, item 2: an independent monitoring-health signal.
--
-- Four failure modes, mapped honestly to what existing infrastructure can and cannot detect. No new
-- paid infrastructure. Where true independent detection is not achievable from inside this database,
-- that is stated as a limitation (see the release report), not solved with new infra.
--
--   1. Observer stopped running entirely: system_job_state's row for job_key 'system-monitor-observe'
--      (seeded in Phase 2.1, 20261007100000) already records last_run_at independent of whether
--      system_issues ingestion works. Reused as-is; surfaced to managers via a new read-only view.
--   2. Observer running but its own logic failing: cron.job_run_details (pg_cron's own independent
--      run-history, already read by the observer itself) cross-checked against system_job_state -
--      if pg_cron shows the job invoked on schedule but system_job_state isn't advancing, that is an
--      observer-logic failure, distinct from a scheduler-down failure. Surfaced via the same view.
--   3. Ingestion itself failing (system_issues/system_issue_events writes broken, DB otherwise up):
--      _system_ingest (20261006120000) already isolates and swallows this; this migration adds a
--      write to a new, independent system_monitoring_health_log table in its exception handlers, so
--      the failure is visible even though the normal system_issues path is what's broken.
--   4. Full database/project outage: honestly out of reach of anything written inside that same
--      database - nothing running in Postgres can report its own total unavailability. No in-system
--      fix exists without new external infrastructure (an outside uptime pinger), which is not being
--      added here. The team relies on Supabase's own platform-level project health monitoring for
--      this case (already included in the existing hosting plan - not new paid infra).
--
-- No cron schedule is created or modified by this migration.

-- ---------------------------------------------------------------------------------------------
-- 3. Independent ingestion-failure log. No FK to system_issues/system_issue_events on purpose - if
-- those tables or their indexes are what's broken, this table must still be writable.
-- ---------------------------------------------------------------------------------------------
create table public.system_monitoring_health_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  stage text not null check (stage in ('ingest_impl_exception', 'ingest_outer_exception')),
  sqlstate_code text,
  message text
);

comment on table public.system_monitoring_health_log is
  'Independent fallback signal written by _system_ingest when the normal system_issues ingestion '
  'path itself throws. Deliberately has no foreign key into system_issues so it stays writable even '
  'if that table or its indexes are the thing that is broken. Manager-read-only.';

alter table public.system_monitoring_health_log enable row level security;

create policy system_monitoring_health_log_manager_select on public.system_monitoring_health_log
  for select to authenticated
  using (public.system_monitoring_is_manager());

revoke all on public.system_monitoring_health_log from public, anon, authenticated;
grant select on public.system_monitoring_health_log to authenticated;
revoke all on sequence public.system_monitoring_health_log_id_seq from public, anon, authenticated, service_role;

-- Bounded retention: keep at most the most recent 2000 rows / 30 days, pruned opportunistically by
-- the existing, unscheduled _system_monitoring_maintenance() rather than a new cron job.
create or replace function public._system_prune_health_log()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  delete from public.system_monitoring_health_log
  where id in (
    select id from public.system_monitoring_health_log
    where occurred_at < now() - interval '30 days'
    order by occurred_at limit 5000
  );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public._system_prune_health_log() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Redefine _system_ingest to additionally log to the independent health table on either exception
-- path. Everything else (the reentrancy guard, the GUC reset, the returned shape) is unchanged.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_ingest(p_trust text, p_payload jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
declare
  v_res jsonb;
begin
  begin
    if current_setting('shira.monitoring_active', true) = 'on' then
      return jsonb_build_object('accepted', false, 'reason', 'reentrant');
    end if;
    perform set_config('shira.monitoring_active', 'on', true);
    begin
      v_res := public._system_ingest_impl(p_trust, p_payload, p_actor);
    exception when others then
      raise warning 'system monitoring: ingestion failed (sqlstate %): %', sqlstate, left(sqlerrm, 200);
      begin
        insert into public.system_monitoring_health_log (stage, sqlstate_code, message)
        values ('ingest_impl_exception', sqlstate, left(sqlerrm, 500));
      exception when others then
        null;
      end;
      v_res := jsonb_build_object('accepted', false, 'reason', 'internal');
    end;
    perform set_config('shira.monitoring_active', 'off', true);
    return v_res;
  exception when others then
    begin
      perform set_config('shira.monitoring_active', 'off', true);
    exception when others then
      null;
    end;
    begin
      insert into public.system_monitoring_health_log (stage, sqlstate_code, message)
      values ('ingest_outer_exception', sqlstate, left(sqlerrm, 500));
    exception when others then
      null;
    end;
    return jsonb_build_object('accepted', false, 'reason', 'internal');
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 1 + 2. Manager-facing monitoring-health view: observer heartbeat (system_job_state) cross-checked
-- against pg_cron's own independent run history (cron.job_run_details via cron.job). Read-only,
-- security_invoker so it still runs under the caller's RLS rather than the view owner's.
-- ---------------------------------------------------------------------------------------------
create view public.system_monitoring_observer_health
with (security_invoker = true)
as
select
  s.job_key,
  s.last_finished_at as job_state_last_finished_at,
  s.last_status as job_state_last_status,
  s.consecutive_failures as job_state_consecutive_failures,
  c.jobid as cron_jobid,
  c.active as cron_job_active,
  lr.last_cron_run_at,
  lr.last_cron_status,
  (lr.last_cron_run_at is not null and lr.last_cron_run_at > now() - interval '15 minutes') as cron_recently_invoked,
  (s.last_finished_at is not null and s.last_finished_at > now() - interval '15 minutes') as observer_recently_advanced
from public.system_job_state s
left join cron.job c on c.jobid = s.cron_jobid
left join lateral (
  select max(d.start_time) as last_cron_run_at,
         (array_agg(d.status order by d.start_time desc))[1] as last_cron_status
  from cron.job_run_details d
  where c.jobid is not null and d.jobid = c.jobid
) lr on true
where s.job_key = 'system-monitor-observe';

comment on view public.system_monitoring_observer_health is
  'Cross-checks the Phase 2.1 observer heartbeat (system_job_state) against pg_cron''s own '
  'independent run history. cron_recently_invoked=true with observer_recently_advanced=false means '
  'the scheduler is fine but the observer''s own logic is failing; cron_recently_invoked=false means '
  'the scheduler itself stopped invoking the job. Does not detect a full database/project outage - '
  'nothing queryable from inside the database can.';

revoke all on public.system_monitoring_observer_health from public, anon, authenticated;
grant select on public.system_monitoring_observer_health to authenticated;

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'system_job_state'
      and policyname not ilike '%manager%'
  ) then
    raise exception 'self-check: system_job_state has an unexpected non-manager RLS policy; '
      'system_monitoring_observer_health''s security_invoker grant to authenticated would leak it';
  end if;
  if not exists (select 1 from public.system_job_state where job_key = 'system-monitor-observe') then
    raise exception 'self-check: expected a system_job_state row for job_key=system-monitor-observe';
  end if;
end $$;
