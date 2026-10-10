-- System monitoring Phase 2.4: job-infrastructure issue reporting + recovery (dry_run and the REAL live path), driven by SYNTHETIC
-- scheduler data. The cron adapters are replaced inside the transaction by readers of temp tables and the observer is called with an
-- explicit "now". Everything (including temporary replacement of _system_ingest in the failure tests, done in rolled-back
-- sub-transactions) is rolled back at the end.
--
-- Covers: mode matrix, dry-run writes nothing, live open / dedupe / refresh cadence, failed / missing / disabled / stuck, recovery,
-- independence of conditions, recurrence (reopen), confirm hysteresis, severity cap (never above error), healthy / unregistered /
-- business-field inertness, reporter-failure isolation, dry_run -> live switch, muted / acknowledged handling, and that no
-- notification path exists.
set client_min_messages to notice;
begin;

create temp table fk_jobs (jobid bigint primary key, jobname text, schedule text, command text, active boolean default true);
create temp table fk_runs (runid bigint generated always as identity primary key, jobid bigint, status text, return_message text,
                           start_time timestamptz, end_time timestamptz);

create or replace function public._system_cron_jobs()
returns table (jobid bigint, jobname text, schedule text, command text, active boolean)
language sql stable set search_path = public, pg_temp
as $$ select j.jobid, j.jobname, j.schedule, j.command, j.active from pg_temp.fk_jobs j $$;
create or replace function public._system_cron_max_runid()
returns bigint language sql stable set search_path = public, pg_temp
as $$ select coalesce(max(r.runid), 0)::bigint from pg_temp.fk_runs r $$;
create or replace function public._system_cron_runs(p_after bigint, p_ids bigint[], p_limit integer)
returns table (runid bigint, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql stable set search_path = public, pg_temp
as $$ select r.runid, r.jobid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
      where r.runid > coalesce(p_after, 0) or r.runid = any (coalesce(p_ids, '{}'::bigint[])) order by r.runid limit p_limit $$;
create or replace function public._system_cron_recent_runs(p_jobid bigint, p_n integer)
returns table (runid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql stable set search_path = public, pg_temp
as $$ select r.runid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
      where r.jobid = p_jobid order by r.runid desc limit p_n $$;

create function pg_temp.fk_run(p_jobid bigint, p_start timestamptz, p_status text default 'succeeded', p_dur_s integer default 1)
returns bigint language sql as $$
  insert into pg_temp.fk_runs (jobid, status, return_message, start_time, end_time)
  values (p_jobid, p_status, '1 row', p_start, case when p_status in ('succeeded', 'failed') then p_start + make_interval(secs => p_dur_s) end)
  returning runid
$$;
create function pg_temp.st(p_key text) returns public.system_job_state language sql as $$
  select s from public.system_job_state s where s.job_key = p_key
$$;
create function pg_temp.key(p_job text, p_cond text) returns text language sql as $$ select 'job_health:' || p_job || ':' || p_cond $$;
create function pg_temp.iss(p_job text, p_cond text) returns public.system_issues language sql as $$
  select i from public.system_issues i where i.fingerprint = public._system_fingerprint(null, null, null, null, null, null, null, pg_temp.key(p_job, p_cond))
$$;
create function pg_temp.n_issues() returns bigint language sql as $$ select count(*) from public.system_issues $$;
create function pg_temp.mon_rows() returns bigint language sql as $$
  select (select count(*) from public.system_issues) + (select count(*) from public.system_issue_events) + (select count(*) from public.system_issue_buckets)
       + (select count(*) from public.system_issue_transitions) + (select count(*) from public.system_report_quota)
$$;
create function pg_temp.cond(p_job text, p_cond text) returns jsonb language sql as $$
  select (s.reporting -> 'c' -> p_cond) from public.system_job_state s where s.job_key = p_job
$$;
create function pg_temp.obs(p_now timestamptz) returns jsonb language sql as $$ select public._system_job_observe(p_now) $$;

-- Mode helper. live = issue_mode live + report_enabled true + shadow false.
create function pg_temp.mode(p text) returns void language plpgsql as $$
begin
  update public.system_monitoring_config set value = value || case p
    when 'live' then jsonb_build_object('issue_mode', 'live', 'report_enabled', true, 'shadow', false)
    when 'dry_run' then jsonb_build_object('issue_mode', 'dry_run', 'report_enabled', false, 'shadow', true)
    when 'off' then jsonb_build_object('issue_mode', 'off', 'report_enabled', false, 'shadow', true) end
  where key = 'job_monitoring';
end $$;

-- Fixture: the 7 business jobs + the observer, healthy history ending just before t0.
create function pg_temp.fresh(p_mode text) returns void language plpgsql as $$
declare
  t0 constant timestamptz := '2026-10-01 12:00:00+00';
  i integer;
begin
  delete from public.system_issue_events; delete from public.system_issue_buckets; delete from public.system_issue_transitions;
  delete from public.system_issues; delete from public.system_report_quota;
  truncate pg_temp.fk_jobs; truncate pg_temp.fk_runs restart identity;
  insert into pg_temp.fk_jobs values
    (104, 'whatsapp-session-reminders', '*/30 * * * *', 'select a();', true),
    (105, 'whatsapp-dispatch-notifications', '*/5 * * * *', 'select b();', true),
    (106, 'birthday-direct-messages', '0 * * * *', 'select c();', true),
    (107, 'push-session-reminders', '*/15 * * * *', 'select d();', true),
    (108, 'open-weekly-registrations', '*/15 * * * *', 'select e();', true),
    (109, 'generate-subscription-charges', '0 3 * * *', 'select f();', true),
    (111, 'maintain-session-series-horizon', '15 2 * * *', 'select g();', true),
    (120, 'system-monitor-observe', '*/5 * * * *', 'select public._system_job_observe();', true);
  perform pg_temp.fk_run(j, t0 - make_interval(secs => k * s)) from (values
    (104, 1800), (105, 300), (106, 3600), (107, 900), (108, 900), (109, 86400), (111, 86400), (120, 300)) v(j, s)
    cross join generate_series(11, 0, -1) k;
  update public.system_job_state set cursor = '{}', last_run_id = 0, runs_observed = 0, last_started_at = null, last_finished_at = null,
    last_technical_success_at = null, last_failure_at = null, last_status = null, last_technical_outcome = 'unknown', last_outcome = 'unknown',
    consecutive_failures = 0, consecutive_ok = 0, last_duration_ms = null, last_result = '{}', stale = false, stale_since = null,
    shadow = '{}', last_observed_at = null, cron_jobid = null, schedule = null, command_hash = null, present = true, missing_since = null,
    grace_until = null, active = true, monitored = true, reporting = '{}', last_business_success_at = null,
    stale_after_s = case job_key when 'whatsapp-dispatch-notifications' then 720 when 'push-session-reminders' then 1920
      when 'open-weekly-registrations' then 1920 when 'whatsapp-session-reminders' then 3720 when 'birthday-direct-messages' then 7320
      when 'generate-subscription-charges' then 93600 when 'maintain-session-series-horizon' then 93600 else 1020 end;
  perform pg_temp.mode(p_mode);
  perform public._system_job_observe(t0);
end $$;

-- Keep every job except the listed ones alive up to p_t (adds one run per job at p_t - 10s).
create function pg_temp.alive(p_t timestamptz, p_except text[] default '{}') returns void language sql as $$
  insert into pg_temp.fk_runs (jobid, status, return_message, start_time, end_time)
  select j.jobid, 'succeeded', '1 row', p_t - interval '10 seconds', p_t - interval '9 seconds'
  from pg_temp.fk_jobs j where j.jobname <> all (p_except) and j.active
$$;

-- Run one observer cycle at p_t after keeping all non-excepted jobs alive.
create function pg_temp.cyc(p_t timestamptz, p_except text[] default '{}') returns jsonb language plpgsql as $$
begin
  perform pg_temp.alive(p_t, p_except);
  return public._system_job_observe(p_t);
end $$;

do $$
declare
  t0 constant timestamptz := '2026-10-01 12:00:00+00';
  v_i public.system_issues;
  v_n bigint;
  v_rep jsonb;
  v_res jsonb;
  k integer;
  v_t timestamptz;
begin
  -- ===== R0: mode matrix (fail-safe) =====
  perform pg_temp.mode('off');
  if public._system_job_issue_mode() <> 'off' then raise exception 'R0 FAILED: off'; end if;
  perform pg_temp.mode('dry_run');
  if public._system_job_issue_mode() <> 'dry_run' then raise exception 'R0 FAILED: dry_run'; end if;
  perform pg_temp.mode('live');
  if public._system_job_issue_mode() <> 'live' then raise exception 'R0 FAILED: live'; end if;
  update public.system_monitoring_config set value = value || '{"shadow": true}' where key = 'job_monitoring';
  if public._system_job_issue_mode() <> 'dry_run' then raise exception 'R0 FAILED: live requested with shadow=true must run as dry_run'; end if;
  update public.system_monitoring_config set value = value || '{"shadow": false, "report_enabled": false}' where key = 'job_monitoring';
  if public._system_job_issue_mode() <> 'dry_run' then raise exception 'R0 FAILED: live requested with report_enabled=false must run as dry_run'; end if;
  update public.system_monitoring_config set value = value || '{"issue_mode": "banana"}' where key = 'job_monitoring';
  if public._system_job_issue_mode() <> 'off' then raise exception 'R0 FAILED: unknown mode must be off'; end if;
  update public.system_monitoring_config set value = value - 'issue_mode' where key = 'job_monitoring';
  if public._system_job_issue_mode() <> 'off' then raise exception 'R0 FAILED: absent mode must be off'; end if;
  raise notice 'R0 PASSED: off / dry_run / live; live needs issue_mode=live AND report_enabled AND NOT shadow; unknown or absent = off';

  -- ===== R1: DRY RUN decides but writes no monitoring row =====
  perform pg_temp.fresh('dry_run');
  v_n := pg_temp.mon_rows();
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);   -- stale (age ~14 min > 720 s): candidate
  if not (pg_temp.st('whatsapp-dispatch-notifications')).stale then raise exception 'R1 FAILED: fixture not stale'; end if;
  if (pg_temp.cond('whatsapp-dispatch-notifications', 'stale') ->> 'open')::boolean then raise exception 'R1 FAILED: opened on the first cycle'; end if;
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);   -- second consecutive cycle: qualifies
  v_i := null;
  if not (pg_temp.cond('whatsapp-dispatch-notifications', 'stale') ->> 'open')::boolean
     or (pg_temp.cond('whatsapp-dispatch-notifications', 'stale') ->> 'm') <> 'dry_run'
     or (pg_temp.cond('whatsapp-dispatch-notifications', 'stale') ->> 'act') <> 'open' then
    raise exception 'R1 FAILED: dry-run decision not recorded: %', pg_temp.cond('whatsapp-dispatch-notifications', 'stale');
  end if;
  if pg_temp.mon_rows() <> v_n then raise exception 'R1 FAILED: dry-run wrote monitoring rows'; end if;
  v_rep := (pg_temp.st('system-monitor-observe')).reporting;
  if v_rep ->> 'mode' <> 'dry_run' or jsonb_array_length(v_rep -> 'recent') <> 1
     or v_rep -> 'recent' -> 0 ->> 'a' <> 'open' or v_rep -> 'recent' -> 0 ->> 's' <> 'warning' or v_rep -> 'recent' -> 0 ->> 'j' <> 'whatsapp-dispatch-notifications' then
    raise exception 'R1 FAILED: evidence ring: %', v_rep;
  end if;
  if ((pg_temp.st('system-monitor-observe')).last_result ->> 'issue_mode') <> 'dry_run' then raise exception 'R1 FAILED: last_result.issue_mode'; end if;
  for k in 1..8 loop perform pg_temp.cyc(t0 + interval '18 minutes' + make_interval(mins => 5 * k), array['whatsapp-dispatch-notifications']); end loop;
  if jsonb_array_length((pg_temp.st('system-monitor-observe')).reporting -> 'recent') <> 1 then raise exception 'R1 FAILED: continued condition must be a no-op inside the refresh window'; end if;
  perform pg_temp.cyc(t0 + interval '18 minutes' + interval '3600 seconds', array['whatsapp-dispatch-notifications']);
  v_rep := (pg_temp.st('system-monitor-observe')).reporting;
  if jsonb_array_length(v_rep -> 'recent') <> 2 or v_rep -> 'recent' -> 0 ->> 'a' <> 'update' or (v_rep -> 'totals' ->> 'update')::int <> 1 then
    raise exception 'R1 FAILED: refresh decision: %', v_rep;
  end if;
  if pg_temp.mon_rows() <> v_n then raise exception 'R1 FAILED: dry-run wrote monitoring rows after refresh'; end if;
  raise notice 'R1 PASSED: dry_run records open/update decisions (bounded evidence on the observer row) and writes ZERO monitoring rows';

  -- ===== R2: LIVE stale: exactly one issue, dedupe, refresh cadence, wording, identity =====
  perform pg_temp.fresh('live');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  if pg_temp.n_issues() <> 0 then raise exception 'R2 FAILED: issue created on the first unhealthy cycle'; end if;
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if v_i.id is null or pg_temp.n_issues() <> 1 then raise exception 'R2 FAILED: expected exactly one issue, got %', pg_temp.n_issues(); end if;
  if v_i.status <> 'open' or v_i.severity <> 'warning' or v_i.source <> 'cron' or v_i.subsystem <> 'notifications'
     or v_i.operation <> 'cron/whatsapp-dispatch-notifications' or v_i.error_code <> 'job_stale' or v_i.error_class <> 'JobHealth'
     or v_i.occurrence_count <> 1 or v_i.latest_summary !~ 'has not started within its expected window' then
    raise exception 'R2 FAILED: issue content %', to_jsonb(v_i);
  end if;
  if v_i.fingerprint <> md5('key' || chr(31) || 'job_health:whatsapp-dispatch-notifications:stale') then raise exception 'R2 FAILED: fingerprint is not the stable key hash'; end if;
  for k in 1..10 loop perform pg_temp.cyc(t0 + interval '18 minutes' + make_interval(mins => 5 * k), array['whatsapp-dispatch-notifications']); end loop;
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if pg_temp.n_issues() <> 1 or v_i.occurrence_count <> 1 then raise exception 'R2 FAILED: continued condition duplicated or recounted (issues %, occurrences %)', pg_temp.n_issues(), v_i.occurrence_count; end if;
  perform pg_temp.cyc(t0 + interval '18 minutes' + interval '3600 seconds', array['whatsapp-dispatch-notifications']);
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if pg_temp.n_issues() <> 1 or v_i.occurrence_count <> 2 or v_i.severity <> 'warning' then
    raise exception 'R2 FAILED: refresh must add exactly one occurrence without changing severity: %', to_jsonb(v_i);
  end if;
  if (select count(*) from public.system_issue_transitions where issue_id = v_i.id) <> 1 then raise exception 'R2 FAILED: transitions'; end if;
  raise notice 'R2 PASSED: live stale -> one issue after 2 cycles; 10 more cycles add nothing; one refresh adds exactly one occurrence; identity = md5(key)';

  -- ===== R3: LIVE failed (+ severity cap on a critical escalation) =====
  perform pg_temp.fresh('live');
  perform pg_temp.fk_run(107, t0 + interval '2 minutes', 'failed');
  perform pg_temp.cyc(t0 + interval '5 minutes', array['push-session-reminders']);
  perform pg_temp.cyc(t0 + interval '10 minutes', array['push-session-reminders']);
  v_i := pg_temp.iss('push-session-reminders', 'failed');
  if v_i.id is null or v_i.error_code <> 'job_failed' or v_i.severity <> 'warning' or v_i.latest_summary !~ 'ended with an error at the scheduler level' then
    raise exception 'R3 FAILED: %', to_jsonb(v_i);
  end if;
  if v_i.latest_summary ~* 'billing|business|charge' then raise exception 'R3 FAILED: wording claims more than is known'; end if;
  -- open-weekly-registrations: escalation failure.after=3 -> critical in JSON; Phase 2.4 must cap at error
  for k in 1..3 loop perform pg_temp.fk_run(108, t0 + interval '10 minutes' + make_interval(mins => k), 'failed'); end loop;
  perform pg_temp.cyc(t0 + interval '15 minutes', array['open-weekly-registrations', 'push-session-reminders']);
  perform pg_temp.cyc(t0 + interval '20 minutes', array['open-weekly-registrations', 'push-session-reminders']);
  v_i := pg_temp.iss('open-weekly-registrations', 'failed');
  if v_i.id is null or v_i.severity <> 'error' then raise exception 'R3 FAILED: core failed job must be error (capped), got %', v_i.severity; end if;
  raise notice 'R3 PASSED: failed job opens a factual issue; a core job whose escalation says critical is capped at error';

  -- ===== R4: missing / R5: disabled / R6: stuck =====
  perform pg_temp.fresh('live');
  delete from pg_temp.fk_jobs where jobname = 'maintain-session-series-horizon';
  perform pg_temp.cyc(t0 + interval '5 minutes');
  perform pg_temp.cyc(t0 + interval '10 minutes');
  v_i := pg_temp.iss('maintain-session-series-horizon', 'missing');
  if v_i.id is null or v_i.error_code <> 'job_missing' or v_i.severity <> 'error' or v_i.latest_summary !~ 'not present in the scheduler' then raise exception 'R4 FAILED: %', to_jsonb(v_i); end if;
  update public.system_job_state set monitored = false where job_key = 'generate-subscription-charges';          -- planned removal: monitored=false
  delete from pg_temp.fk_jobs where jobname = 'generate-subscription-charges';
  perform pg_temp.cyc(t0 + interval '15 minutes'); perform pg_temp.cyc(t0 + interval '20 minutes');
  if (pg_temp.iss('generate-subscription-charges', 'missing')).id is not null then raise exception 'R4 FAILED: monitored=false job must not be reported'; end if;
  raise notice 'R4 PASSED: a registered monitored job missing from the scheduler opens a job_missing issue; monitored=false is the planned-removal switch';

  perform pg_temp.fresh('live');
  update pg_temp.fk_jobs set active = false where jobname = 'birthday-direct-messages';
  perform pg_temp.cyc(t0 + interval '5 minutes', array['birthday-direct-messages']);
  perform pg_temp.cyc(t0 + interval '10 minutes', array['birthday-direct-messages']);
  v_i := pg_temp.iss('birthday-direct-messages', 'disabled');
  if v_i.id is null or v_i.error_code <> 'job_disabled' or v_i.severity <> 'warning' then raise exception 'R5 FAILED: %', to_jsonb(v_i); end if;
  if (pg_temp.iss('birthday-direct-messages', 'stale')).id is not null then raise exception 'R5 FAILED: a disabled job must not also be reported stale'; end if;
  raise notice 'R5 PASSED: disabled job -> job_disabled (and not stale)';

  perform pg_temp.fresh('live');
  insert into pg_temp.fk_runs (jobid, status, return_message, start_time, end_time) values (106, 'running', null, t0 + interval '1 minute', null);
  perform pg_temp.cyc(t0 + interval '13 minutes', array['birthday-direct-messages']);   -- running 12 min > 600 s
  perform pg_temp.cyc(t0 + interval '18 minutes', array['birthday-direct-messages']);
  v_i := pg_temp.iss('birthday-direct-messages', 'stuck');
  if v_i.id is null or v_i.error_code <> 'job_stuck' or v_i.latest_summary !~ 'running longer than expected' then raise exception 'R6 FAILED: %', to_jsonb(v_i); end if;
  raise notice 'R6 PASSED: a run in flight beyond the stuck threshold -> job_stuck';

  -- ===== R7 recovery + R9 recurrence =====
  perform pg_temp.fresh('live');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if v_i.status <> 'open' then raise exception 'R7 FAILED: fixture'; end if;
  perform pg_temp.fk_run(105, t0 + interval '22 minutes');                                  -- the job runs again
  perform pg_temp.cyc(t0 + interval '23 minutes');                                           -- healthy cycle 1: still open (confirm)
  if (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).status <> 'open' then raise exception 'R7 FAILED: resolved after a single healthy cycle'; end if;
  perform pg_temp.cyc(t0 + interval '28 minutes');                                           -- healthy cycle 2: resolves
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if v_i.status <> 'resolved' or v_i.resolution <> 'auto_recovered' or v_i.resolved_by is not null or v_i.resolved_at is null then raise exception 'R7 FAILED: %', to_jsonb(v_i); end if;
  if not exists (select 1 from public.system_issue_transitions where issue_id = v_i.id and kind = 'auto_resolve' and from_status = 'open' and to_status = 'resolved' and reason = 'auto_recovered') then
    raise exception 'R7 FAILED: transition';
  end if;
  raise notice 'R7 PASSED: recovery needs 2 healthy cycles, then resolves the issue (auto_recovered / auto_resolve)';

  -- R9: recurrence reopens the SAME issue
  perform pg_temp.cyc(t0 + interval '50 minutes', array['whatsapp-dispatch-notifications']);     -- stale again (age > 12 min)
  perform pg_temp.cyc(t0 + interval '55 minutes', array['whatsapp-dispatch-notifications']);
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if pg_temp.n_issues() <> 1 or v_i.status <> 'open' or v_i.reopen_count <> 1 then raise exception 'R9 FAILED: expected the same issue reopened, got % issues %', pg_temp.n_issues(), to_jsonb(v_i); end if;
  if not exists (select 1 from public.system_issue_transitions where issue_id = v_i.id and kind = 'auto_reopen') then raise exception 'R9 FAILED: no auto_reopen transition'; end if;
  raise notice 'R9 PASSED: recurrence after recovery reopens the same issue (reopen_count=1, auto_reopen), no new issue';

  -- ===== R8: conditions are independent =====
  perform pg_temp.fresh('live');
  perform pg_temp.fk_run(107, t0 + interval '2 minutes', 'failed');
  update pg_temp.fk_jobs set active = false where jobname = 'push-session-reminders';
  perform pg_temp.cyc(t0 + interval '5 minutes', array['push-session-reminders']);
  perform pg_temp.cyc(t0 + interval '10 minutes', array['push-session-reminders']);
  if (pg_temp.iss('push-session-reminders', 'failed')).status is distinct from 'open' or (pg_temp.iss('push-session-reminders', 'disabled')).status is distinct from 'open' then
    raise exception 'R8 FAILED: both conditions should be open';
  end if;
  update pg_temp.fk_jobs set active = true where jobname = 'push-session-reminders';
  perform pg_temp.cyc(t0 + interval '15 minutes', array['push-session-reminders']);
  perform pg_temp.cyc(t0 + interval '20 minutes', array['push-session-reminders']);
  if (pg_temp.iss('push-session-reminders', 'disabled')).status <> 'resolved' then raise exception 'R8 FAILED: disabled should have resolved'; end if;
  if (pg_temp.iss('push-session-reminders', 'failed')).status <> 'open' then raise exception 'R8 FAILED: failed must stay open while the failure persists'; end if;
  raise notice 'R8 PASSED: resolving one condition (disabled) leaves the other (failed) open';

  -- ===== R10: hysteresis against flapping =====
  perform pg_temp.fresh('live');
  update public.system_job_state set stale_after_s = 100 where job_key = 'whatsapp-dispatch-notifications';
  for k in 1..8 loop
    v_t := t0 + make_interval(mins => 5 * k);
    if k % 2 = 0 then perform pg_temp.fk_run(105, v_t - interval '30 seconds'); end if;       -- healthy on even cycles, stale on odd cycles
    perform pg_temp.cyc(v_t, array['whatsapp-dispatch-notifications']);
  end loop;
  if pg_temp.n_issues() <> 0 then raise exception 'R10 FAILED: alternating stale/healthy must never open (needs 2 consecutive)'; end if;
  -- now open it for real, then alternate: must neither resolve nor reopen/duplicate
  perform pg_temp.cyc(t0 + interval '45 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '50 minutes', array['whatsapp-dispatch-notifications']);
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if v_i.id is null or v_i.status <> 'open' then raise exception 'R10 FAILED: fixture did not open'; end if;
  for k in 1..8 loop
    v_t := t0 + interval '50 minutes' + make_interval(mins => 5 * k);
    if k % 2 = 1 then perform pg_temp.fk_run(105, v_t - interval '30 seconds'); end if;       -- healthy on odd cycles, stale on even cycles
    perform pg_temp.cyc(v_t, array['whatsapp-dispatch-notifications']);
  end loop;
  v_i := pg_temp.iss('whatsapp-dispatch-notifications', 'stale');
  if pg_temp.n_issues() <> 1 or v_i.status <> 'open' or v_i.reopen_count <> 0 or v_i.occurrence_count <> 1 then
    raise exception 'R10 FAILED: flapping caused lifecycle churn: %', to_jsonb(v_i);
  end if;
  raise notice 'R10 PASSED: alternating healthy/unhealthy cycles neither open nor resolve nor reopen (confirm hysteresis)';

  -- ===== R11: healthy / unregistered / business fields are inert =====
  perform pg_temp.fresh('live');
  update public.system_job_state set last_outcome = 'soft_failure', last_business_success_at = t0 - interval '30 days' where job_key = 'generate-subscription-charges';
  update public.system_job_state set last_outcome = 'hard_failure' where job_key = 'maintain-session-series-horizon';
  for k in 1..12 loop perform pg_temp.cyc(t0 + make_interval(mins => 5 * k)); end loop;
  if pg_temp.mon_rows() <> 0 then raise exception 'R11 FAILED: healthy jobs (incl. unfavourable business-outcome fields) created monitoring rows'; end if;
  insert into pg_temp.fk_jobs values (500, 'surprise-job', '*/10 * * * *', 'select 1;', true);
  perform pg_temp.fk_run(500, t0 + interval '70 minutes'); perform pg_temp.fk_run(500, t0 + interval '80 minutes'); perform pg_temp.fk_run(500, t0 + interval '90 minutes');
  perform pg_temp.cyc(t0 + interval '95 minutes', array['surprise-job']);
  update public.system_job_state set expected_interval_s = 300, interval_source = 'configured', stale_after_s = 300, grace_until = null where job_key = 'surprise-job';
  for k in 20..60 loop perform pg_temp.cyc(t0 + make_interval(mins => 5 * k), array['surprise-job']); end loop;       -- surprise job silent for ~2 h: stale internally, never reported
  if not (pg_temp.st('surprise-job')).stale then raise exception 'R11 FAILED: fixture (the unregistered job should be stale)'; end if;
  if not (pg_temp.st('surprise-job')).shadow ? 'would_be_unregistered' then raise exception 'R11 FAILED: fixture (unregistered flag)'; end if;
  if (select count(*) from public.system_issues where operation = 'cron/surprise-job') <> 0 then raise exception 'R11 FAILED: unregistered job reported'; end if;
  if pg_temp.n_issues() <> 0 then raise exception 'R11 FAILED: unexpected issue(s): %', (select jsonb_agg(operation) from public.system_issues); end if;
  raise notice 'R11 PASSED: healthy jobs, unregistered jobs and unfavourable business-outcome fields create nothing';

  -- ===== R12: severity can never exceed error =====
  declare
    p public.system_job_state; c text; s text;
  begin
    foreach c in array array['stale', 'failed', 'missing', 'disabled', 'stuck'] loop
      foreach s in array array['critical', 'error', 'warning', 'info', 'bogus'] loop
        p := json_populate_record(null::public.system_job_state, jsonb_build_object('job_key', 'x', 'severity_stale', s, 'severity_failure', s,
              'consecutive_failures', 50, 'last_started_at', '2020-01-01T00:00:00Z',
              'escalation', jsonb_build_object('stale', jsonb_build_object('after_s', 1, 'severity', 'critical'), 'failure', jsonb_build_object('after', 1, 'severity', 'critical')))::json);
        if public._system_job_issue_severity(p, c, now()) not in ('info', 'warning', 'error') then raise exception 'R12 FAILED: %/% -> %', c, s, public._system_job_issue_severity(p, c, now()); end if;
      end loop;
    end loop;
    foreach s in array array['"x"', '{"stale":"critical"}', '{"stale":{"after_s":-5,"severity":"critical"}}', '{"stale":{"after_s":"1","severity":7}}',
                               '{"failure":{"after":[1],"severity":{"a":1}}}', '[1,2]', '"critical"', '{"stale":{"after_s":1,"severity":"critical","only_when_mode":"live"}}', 'null'] loop
      p := json_populate_record(null::public.system_job_state, jsonb_build_object('job_key', 'x', 'severity_stale', 'critical', 'consecutive_failures', 9, 'escalation', s::jsonb)::json);
      foreach c in array array['stale', 'failed'] loop
        if public._system_job_issue_severity(p, c, now()) not in ('warning', 'error') then raise exception 'R12 FAILED: garbage escalation % -> %', s, public._system_job_issue_severity(p, c, now()); end if;
      end loop;
    end loop;
  end;
  if exists (select 1 from public.system_issues where severity = 'critical' or base_severity = 'critical')
     or exists (select 1 from public.system_issue_events where severity = 'critical') then raise exception 'R12 FAILED: a critical issue/event exists'; end if;
  raise notice 'R12 PASSED: severity is capped at error for every condition, severity text and (malformed) escalation configuration';

  -- ===== R13: reporter failure isolation =====
  declare
    v_snap text; v_msg text; v_obs_res jsonb; v_c jsonb;
  begin
    -- (a) the engine call RAISES: observer must not fail, detection state must persist, reporting state must not advance
    perform pg_temp.fresh('live');
    perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
    begin
      execute 'create or replace function public._system_ingest(p_trust text, p_payload jsonb, p_actor uuid) returns jsonb language plpgsql as ''begin raise exception ''''synthetic engine failure''''; end''';
      v_obs_res := pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
      v_c := pg_temp.cond('whatsapp-dispatch-notifications', 'stale');
      raise exception 'R13A_SNAPSHOT:%', jsonb_build_object('res', v_obs_res, 'cond', v_c, 'runs', (pg_temp.st('whatsapp-dispatch-notifications')).runs_observed,
                                                           'stale', (pg_temp.st('whatsapp-dispatch-notifications')).stale,
                                                           'last_obs', (pg_temp.st('system-monitor-observe')).last_observed_at, 'issues', pg_temp.n_issues())::text;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not like 'R13A_SNAPSHOT:%' then raise exception 'R13A FAILED: observer raised: %', v_msg; end if;
      v_snap := substr(v_msg, 15);
    end;
    if (v_snap::jsonb -> 'res' ->> 'errors')::int < 0 or (v_snap::jsonb ->> 'stale')::boolean is not true
       or (v_snap::jsonb ->> 'last_obs') is null or (v_snap::jsonb ->> 'issues')::int <> 0
       or coalesce((v_snap::jsonb -> 'cond' ->> 'open')::boolean, false) then
      raise exception 'R13A FAILED: %', v_snap;
    end if;
    if (v_snap::jsonb ->> 'runs')::int < 1 then raise exception 'R13A FAILED: detection state lost: %', v_snap; end if;
    -- the function is restored (sub-transaction rolled back): the next cycle opens the issue for real (retry)
    perform pg_temp.cyc(t0 + interval '23 minutes', array['whatsapp-dispatch-notifications']);
    if (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).id is null then raise exception 'R13A FAILED: not retried after the engine recovered'; end if;

    -- (b) the engine DROPS the report (accepted:false): state records the failure and does not claim an open issue; retried next cycle
    perform pg_temp.fresh('live');
    perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
    begin
      execute 'create or replace function public._system_ingest(p_trust text, p_payload jsonb, p_actor uuid) returns jsonb language plpgsql as ''begin return jsonb_build_object(''''accepted'''', false, ''''reason'''', ''''internal''''); end''';
      perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
      v_c := pg_temp.cond('whatsapp-dispatch-notifications', 'stale');
      raise exception 'R13B_SNAPSHOT:%', v_c::text;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not like 'R13B_SNAPSHOT:%' then raise exception 'R13B FAILED: %', v_msg; end if;
      v_c := substr(v_msg, 15)::jsonb;
    end;
    if coalesce((v_c ->> 'open')::boolean, false) or coalesce((v_c ->> 'fail')::int, 0) < 1 then raise exception 'R13B FAILED: %', v_c; end if;
    perform pg_temp.cyc(t0 + interval '23 minutes', array['whatsapp-dispatch-notifications']);
    if (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).status is distinct from 'open' then raise exception 'R13B FAILED: dropped report not retried'; end if;
    -- (c) the whole reporting step raises: the observer still completes and detection state persists (step-level isolation)
    begin
      execute 'create or replace function public._system_job_report_cycle(p_now timestamptz, p_mode text) returns jsonb language plpgsql as ''begin raise exception ''''boom''''; end''';
      perform pg_temp.fresh('live');
      v_obs_res := pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
      raise exception 'R13C_SNAPSHOT:%', jsonb_build_object('res', v_obs_res, 'stale', (pg_temp.st('whatsapp-dispatch-notifications')).stale, 'last_obs', (pg_temp.st('system-monitor-observe')).last_observed_at)::text;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not like 'R13C_SNAPSHOT:%' then raise exception 'R13C FAILED: observer raised: %', v_msg; end if;
      v_snap := substr(v_msg, 15);
    end;
    if (v_snap::jsonb ->> 'stale')::boolean is not true or (v_snap::jsonb -> 'res' ->> 'ok')::boolean is not false then raise exception 'R13C FAILED: %', v_snap; end if;

    -- (d) one job''s processing raises: the other jobs are still reported (per-job isolation)
    begin
      perform pg_temp.fresh('live');
      execute 'create or replace function public._system_job_issue_severity(p public.system_job_state, p_cond text, p_now timestamptz) returns text language plpgsql as ''begin if p.job_key = ''''whatsapp-dispatch-notifications'''' then raise exception ''''boom''''; end if; return ''''warning''''; end''';
      perform pg_temp.fk_run(107, t0 + interval '2 minutes', 'failed');
      perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications', 'push-session-reminders']);
      perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications', 'push-session-reminders']);
      raise exception 'R13D_SNAPSHOT:%', jsonb_build_object('push', (pg_temp.iss('push-session-reminders', 'failed')).id is not null, 'dispatch', (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).id is not null)::text;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not like 'R13D_SNAPSHOT:%' then raise exception 'R13D FAILED: %', v_msg; end if;
      v_snap := substr(v_msg, 15);
    end;
    if (v_snap::jsonb ->> 'push')::boolean is not true or (v_snap::jsonb ->> 'dispatch')::boolean is not false then raise exception 'R13D FAILED: %', v_snap; end if;
    raise notice 'R13 PASSED: a raising or dropping reporter never fails the observer or loses detection state; reporting state only advances on acceptance and is retried';
  end;

  -- ===== R14: dry_run -> live switch =====
  perform pg_temp.fresh('dry_run');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  if pg_temp.n_issues() <> 0 or not (pg_temp.cond('whatsapp-dispatch-notifications', 'stale') ->> 'open')::boolean then raise exception 'R14 FAILED: fixture'; end if;
  perform pg_temp.mode('live');
  perform pg_temp.cyc(t0 + interval '23 minutes', array['whatsapp-dispatch-notifications']);
  if pg_temp.n_issues() <> 1 or (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).status <> 'open' then raise exception 'R14 FAILED: the dry-run "open" must not suppress the first real open'; end if;
  raise notice 'R14 PASSED: switching dry_run -> live opens real issues on the next cycle (config only)';

  -- ===== R15: muted / acknowledged =====
  perform pg_temp.fresh('live');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  update public.system_issues set status = 'muted', muted_until = now() + interval '1 day' where id = (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).id;
  perform pg_temp.fk_run(105, t0 + interval '22 minutes');
  perform pg_temp.cyc(t0 + interval '23 minutes'); perform pg_temp.cyc(t0 + interval '28 minutes'); perform pg_temp.cyc(t0 + interval '33 minutes');
  if (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).status <> 'muted' then raise exception 'R15 FAILED: recovery touched a muted issue'; end if;
  perform pg_temp.fresh('live');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  update public.system_issues set status = 'acknowledged', acknowledged_at = now() where id = (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).id;
  perform pg_temp.fk_run(105, t0 + interval '22 minutes');
  perform pg_temp.cyc(t0 + interval '23 minutes'); perform pg_temp.cyc(t0 + interval '28 minutes');
  if (pg_temp.iss('whatsapp-dispatch-notifications', 'stale')).status <> 'resolved' then raise exception 'R15 FAILED: acknowledged issue should auto-resolve on recovery'; end if;
  raise notice 'R15 PASSED: muted issues are left alone; acknowledged issues auto-resolve on recovery';

  -- ===== R16: off mode / paused / no notification path =====
  perform pg_temp.fresh('off');
  perform pg_temp.cyc(t0 + interval '13 minutes', array['whatsapp-dispatch-notifications']);
  perform pg_temp.cyc(t0 + interval '18 minutes', array['whatsapp-dispatch-notifications']);
  if pg_temp.mon_rows() <> 0 or (pg_temp.st('whatsapp-dispatch-notifications')).reporting <> '{}'::jsonb then raise exception 'R16 FAILED: off mode did something'; end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('_system_job_report_cycle', '_system_issue_auto_recover', '_system_job_issue_payload', '_system_job_issue_severity',
                               '_system_job_issue_message', '_system_job_issue_mode')
             and p.prosrc ~* '(net\.http|notif|push|expo|whatsapp|invoke_|vault\.)') then
    raise exception 'R16 FAILED: a Phase 2.4 function references a notification / network path';
  end if;
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and c.relname like 'system\_%' and not t.tgisinternal) then
    raise exception 'R16 FAILED: a trigger exists on a monitoring table';
  end if;
  raise notice 'R16 PASSED: mode off is inert; the reporting functions contain no notification / network path; no triggers on monitoring tables';

  -- ===== R17: bounded storage =====
  perform pg_temp.fresh('dry_run');
  for k in 1..60 loop
    perform pg_temp.fk_run(105, t0 + make_interval(mins => 10 * k) - interval '20 minutes');
    perform pg_temp.cyc(t0 + make_interval(mins => 10 * k), array['whatsapp-dispatch-notifications', 'push-session-reminders', 'open-weekly-registrations']);
    perform pg_temp.cyc(t0 + make_interval(mins => 10 * k + 5), array['whatsapp-dispatch-notifications', 'push-session-reminders', 'open-weekly-registrations']);
  end loop;
  if (select max(octet_length(reporting::text)) from public.system_job_state) > 8192
     or jsonb_array_length((pg_temp.st('system-monitor-observe')).reporting -> 'recent') > 20 then
    raise exception 'R17 FAILED: reporting evidence is not bounded';
  end if;
  raise notice 'R17 PASSED: the dry-run evidence stays bounded (ring <= 20 entries, rows <= 8 KB)';

  raise notice 'ALL JOB ISSUE REPORTING TESTS PASSED';
end $$;

rollback;
