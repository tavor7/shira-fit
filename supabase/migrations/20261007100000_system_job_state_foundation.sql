-- System monitoring, Phase 2.1: job-state foundation (shadow period).
--
-- One row per scheduled/background job, keyed by a STABLE NAME (pg_cron job ids are not stable: the
-- opening-schedule trigger unschedules and re-schedules open-weekly-registrations, which issues a new
-- jobid). The observer introduced in 2.2/2.3 maintains these rows from pg_cron's own history. Nothing in
-- the application reads or writes this table; no business cron command is touched.
--
-- Shadow period: config job_monitoring.shadow = true and report_enabled = false. In this phase the
-- observer only maintains this table. It creates no monitoring issues, resolves nothing, and does not read
-- pg_net, Vault or any business data.
--
-- Security (same model as Phase 1): every default grant is revoked first (this project's default
-- privileges grant ALL on new tables to anon / authenticated / service_role); active managers may read
-- every column EXCEPT the private observer `cursor`, through a manager-gated policy; nobody can write.
-- The table has a text primary key: no sequence is created (and the self-check asserts that).

create table public.system_job_state (
  job_key text primary key check (job_key ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  kind text not null default 'pg_cron' check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  cron_jobid bigint,
  schedule text check (char_length(schedule) <= 100),
  command_hash text check (command_hash ~ '^[0-9a-f]{32}$'),
  active boolean not null default true,
  present boolean not null default true,
  missing_since timestamptz,
  registered boolean not null default false,
  monitored boolean not null default true,
  criticality text not null default 'standard' check (criticality in ('core', 'standard', 'low', 'monitor')),
  subsystem text not null default 'cron' check (subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$'),
  expected_interval_s integer check (expected_interval_s > 0),
  interval_source text not null default 'unknown' check (interval_source in ('configured', 'learned', 'unknown')),
  stale_after_s integer check (stale_after_s > 0),
  severity_stale text check (severity_stale in ('info', 'warning', 'error', 'critical')),
  severity_failure text check (severity_failure in ('info', 'warning', 'error', 'critical')),
  severity_soft text check (severity_soft in ('info', 'warning', 'error', 'critical')),
  escalation jsonb not null default '{}'::jsonb
    check (jsonb_typeof(escalation) = 'object' and octet_length(escalation::text) <= 2048),
  recovery_runs integer not null default 2 check (recovery_runs between 1 and 10),
  paused_until timestamptz,
  grace_until timestamptz,
  last_run_id bigint not null default 0 check (last_run_id >= 0),
  runs_observed integer not null default 0 check (runs_observed >= 0),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_technical_success_at timestamptz,
  last_business_success_at timestamptz,
  last_failure_at timestamptz,
  last_status text check (char_length(last_status) <= 20),
  last_technical_outcome text not null default 'unknown' check (last_technical_outcome in ('success', 'failed', 'unknown')),
  last_outcome text not null default 'unknown'
    check (last_outcome in ('ok', 'partial', 'soft_failure', 'hard_failure', 'unknown')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  consecutive_ok integer not null default 0 check (consecutive_ok >= 0),
  last_duration_ms integer check (last_duration_ms >= 0),
  last_result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(last_result) = 'object' and octet_length(last_result::text) <= 512),
  stale boolean not null default false,
  stale_since timestamptz,
  shadow jsonb not null default '{}'::jsonb
    check (jsonb_typeof(shadow) = 'object' and octet_length(shadow::text) <= 1024),
  last_observed_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cursor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor) = 'object' and octet_length(cursor::text) <= 2048)
) with (fillfactor = 70);

comment on table public.system_job_state is
  'Stable-identity state of each scheduled job, maintained by the monitoring observer from pg_cron history. '
  'Managers read every column except cursor; nobody writes through the API.';
comment on column public.system_job_state.cursor is
  'Private observer bookkeeping (run-id high-water mark, in-flight run, recent gaps). Not readable by any client role.';
comment on column public.system_job_state.shadow is
  'Bounded "would be" diagnostics computed during the shadow period (would_be_stale, would_be_missing, ...). '
  'Values are the ISO time the condition started; no issue is created from them in shadow mode.';

-- ---------------------------------------------------------------------------------------------
-- Privileges: revoke every default grant, then the minimum.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.system_job_state from public, anon, authenticated, service_role;
alter table public.system_job_state enable row level security;

grant select (
  job_key, kind, cron_jobid, schedule, command_hash, active, present, missing_since, registered, monitored,
  criticality, subsystem, expected_interval_s, interval_source, stale_after_s, severity_stale, severity_failure,
  severity_soft, escalation, recovery_runs, paused_until, grace_until, last_run_id, runs_observed,
  last_started_at, last_finished_at, last_technical_success_at, last_business_success_at, last_failure_at,
  last_status, last_technical_outcome, last_outcome, consecutive_failures, consecutive_ok, last_duration_ms,
  last_result, stale, stale_since, shadow, last_observed_at, first_seen_at, updated_at
) on public.system_job_state to authenticated;

create policy system_job_state_manager_select on public.system_job_state
  for select to authenticated
  using ((select public.system_monitoring_is_manager()));

-- ---------------------------------------------------------------------------------------------
-- Shadow configuration (developer-controlled; managers cannot read or write this table).
-- shadow = true, report_enabled = false: the observer maintains state only.
-- ---------------------------------------------------------------------------------------------
insert into public.system_monitoring_config (key, value) values
  ('job_monitoring', jsonb_build_object(
    'shadow', true,
    'report_enabled', false,
    'observer_enabled', true,
    'stale_grace_s', 120,
    'learn_min_runs', 3,
    'max_runs_per_cycle', 2000,
    'stuck_min_s', 600,
    'stuck_duration_multiple', 20,
    'scheduler_down_min_jobs', 3,
    'paused_until', null
  ))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Seed rows: the seven production application jobs (identified by NAME, never by job id) and the
-- observer's own row. Thresholds follow the approved matrix and were calibrated against 14 days of real
-- production run timing (0 false stale ticks). Historical removed jobs are NOT seeded.
-- interval_source = 'configured': the observer never overwrites these intervals.
-- ---------------------------------------------------------------------------------------------
insert into public.system_job_state (
  job_key, subsystem, criticality, registered, monitored, expected_interval_s, interval_source, stale_after_s,
  severity_stale, severity_failure, severity_soft, escalation, recovery_runs
) values
  ('whatsapp-session-reminders', 'notifications', 'low', true, true, 1800, 'configured', 3720,
   'warning', 'warning', 'warning', '{}'::jsonb, 2),
  ('whatsapp-dispatch-notifications', 'notifications', 'standard', true, true, 300, 'configured', 720,
   'warning', 'warning', 'warning',
   '{"stale":{"after_s":3600,"severity":"error","only_when_mode":"live"}}'::jsonb, 2),
  ('birthday-direct-messages', 'messaging', 'low', true, true, 3600, 'configured', 7320,
   'warning', 'warning', 'warning', '{}'::jsonb, 2),
  ('push-session-reminders', 'notifications', 'standard', true, true, 900, 'configured', 1920,
   'warning', 'warning', 'warning',
   '{"stale":{"after_s":7200,"severity":"error"},"failure":{"after":6,"severity":"error"}}'::jsonb, 2),
  ('open-weekly-registrations', 'registration', 'core', true, true, 900, 'configured', 1920,
   'error', 'error', 'error',
   '{"stale":{"after_s":10800,"severity":"critical"},"failure":{"after":3,"severity":"critical"}}'::jsonb, 2),
  ('generate-subscription-charges', 'billing', 'core', true, true, 86400, 'configured', 93600,
   'error', 'error', 'error',
   '{"stale":{"after_s":180000,"severity":"critical"},"failure":{"after":2,"severity":"critical"},"soft":{"after":2,"severity":"critical"}}'::jsonb, 1),
  ('maintain-session-series-horizon', 'recurring_sessions', 'standard', true, true, 86400, 'configured', 93600,
   'warning', 'error', 'error',
   '{"stale":{"after_s":180000,"severity":"error"}}'::jsonb, 1),
  ('system-monitor-observe', 'monitoring', 'monitor', true, true, 300, 'configured', 1020,
   'error', 'error', 'error', '{}'::jsonb, 2)
on conflict (job_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Self-check: abort if the final state is not exactly the intended one.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_role text;
  v_col text;
  v_n integer;
begin
  if pg_get_userbyid((select relowner from pg_class where oid = 'public.system_job_state'::regclass)) <> 'postgres' then
    raise exception 'self-check: system_job_state is not owned by postgres';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.system_job_state'::regclass) then
    raise exception 'self-check: RLS is not enabled on system_job_state';
  end if;
  foreach v_role in array array['anon', 'service_role'] loop
    if has_table_privilege(v_role, 'public.system_job_state'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(v_role, 'public.system_job_state'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'self-check: % has a privilege on system_job_state', v_role;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.system_job_state'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_any_column_privilege('authenticated', 'public.system_job_state'::regclass, 'INSERT,UPDATE,REFERENCES') then
    raise exception 'self-check: authenticated has a table-level or write privilege on system_job_state';
  end if;
  if has_column_privilege('authenticated', 'public.system_job_state'::regclass, 'cursor', 'SELECT') then
    raise exception 'self-check: authenticated can read the private cursor column';
  end if;
  for v_col in
    select a.attname::text from pg_attribute a
    where a.attrelid = 'public.system_job_state'::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> 'cursor'
  loop
    if not has_column_privilege('authenticated', 'public.system_job_state'::regclass, v_col, 'SELECT') then
      raise exception 'self-check: authenticated cannot read system_job_state.%', v_col;
    end if;
  end loop;
  -- no sequence may exist for this table (text primary key) and no API role may hold sequence privileges
  select count(*) into v_n from pg_class c
  join pg_depend d on d.objid = c.oid and d.refobjid = 'public.system_job_state'::regclass
  where c.relkind = 'S';
  if v_n <> 0 then
    raise exception 'self-check: unexpected sequence on system_job_state';
  end if;
  if (select count(*) from public.system_job_state) <> 8 then
    raise exception 'self-check: expected 8 seeded job rows';
  end if;
  if (select value from public.system_monitoring_config where key = 'job_monitoring') -> 'report_enabled' <> 'false'::jsonb
     or (select value from public.system_monitoring_config where key = 'job_monitoring') -> 'shadow' <> 'true'::jsonb then
    raise exception 'self-check: job_monitoring must start in shadow mode with reporting disabled';
  end if;
end $$;
