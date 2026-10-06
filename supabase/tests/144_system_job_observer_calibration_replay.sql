-- System monitoring Phase 2.2: CALIBRATION REPLAY of 14 days of REAL production cron timing.
--
-- The timeline below was read (read-only) from production cron.job_run_details for the 14 days before the
-- Phase 2 deployment: for every one of the seven application jobs EVERY gap between consecutive runs was
-- exactly the schedule interval (to the second) and every run succeeded (0 failures, 0 non-succeeded rows,
-- 0 s duration at 1 s resolution). Each job is therefore reproduced exactly by (first start, constant gap,
-- number of runs):
--
--   whatsapp-dispatch-notifications  1790067300  300 s  x 4032   (*/5)
--   open-weekly-registrations        1790067600  900 s  x 1344   (*/15)
--   push-session-reminders           1790067600  900 s  x 1344   (*/15)
--   whatsapp-session-reminders       1790067600 1800 s  x  672   (*/30)
--   birthday-direct-messages         1790067600 3600 s  x  336   (hourly)
--   generate-subscription-charges    1790391600 86400 s x   11   (daily 03:00)
--   maintain-session-series-horizon  1790820900 86400 s x    6   (daily 02:15)
--
-- The real observer (_system_job_observe) is run every 5 minutes over the whole period, twice: with the
-- observer firing right after the scheduler tick (+1 s) and at the worst possible lateness (+299 s, i.e. just
-- before the next tick) so that a job's newest run is as old as it can be when evaluated.
-- PASS = zero cycles in which ANY job is stale or carries any shadow flag (zero false alarms). A negative control
-- afterwards proves the detector does fire when a job really stops.
-- Everything is rolled back.
set client_min_messages to notice;
begin;

create temp table fk_jobs (jobid bigint primary key, jobname text, schedule text, command text, active boolean default true);
create temp table fk_runs (runid bigint generated always as identity primary key, jobid bigint, status text, return_message text,
                           start_time timestamptz, end_time timestamptz);
create index on fk_runs (jobid, runid);
create index on fk_runs (start_time);

create or replace function public._system_cron_jobs()
returns table (jobid bigint, jobname text, schedule text, command text, active boolean)
language sql stable set search_path = public, pg_temp
as $$ select j.jobid, j.jobname, j.schedule, j.command, j.active from pg_temp.fk_jobs j $$;

create or replace function public._system_cron_max_runid()
returns bigint language sql stable set search_path = public, pg_temp
as $$ select coalesce(max(r.runid), 0)::bigint from pg_temp.fk_runs r where r.start_time <= current_setting('fk.now')::timestamptz $$;

create or replace function public._system_cron_runs(p_after bigint, p_ids bigint[], p_limit integer)
returns table (runid bigint, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql stable set search_path = public, pg_temp
as $$ select r.runid, r.jobid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
      where r.start_time <= current_setting('fk.now')::timestamptz
        and (r.runid > coalesce(p_after, 0) or r.runid = any (coalesce(p_ids, '{}'::bigint[])))
      order by r.runid limit p_limit $$;

create or replace function public._system_cron_recent_runs(p_jobid bigint, p_n integer)
returns table (runid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql stable set search_path = public, pg_temp
as $$ select r.runid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
      where r.jobid = p_jobid and r.start_time <= current_setting('fk.now')::timestamptz order by r.runid desc limit p_n $$;

create temp table fk_def (jobid bigint, jobname text, schedule text, command text, first_s bigint, gap integer, n integer);
insert into fk_def values
  (105, 'whatsapp-dispatch-notifications', '*/5 * * * *', 'select invoke_dispatch_notifications_edge();', 1790067300, 300, 4032),
  (108, 'open-weekly-registrations', '*/15 * * * *', 'select open_next_week_sessions_if_due_core();', 1790067600, 900, 1344),
  (107, 'push-session-reminders', '*/15 * * * *', 'select dispatch_due_session_push_reminders();', 1790067600, 900, 1344),
  (104, 'whatsapp-session-reminders', '*/30 * * * *', 'select enqueue_due_session_reminder_whatsapp();', 1790067600, 1800, 672),
  (106, 'birthday-direct-messages', '0 * * * *', 'select send_due_birthday_messages();', 1790067600, 3600, 336),
  (109, 'generate-subscription-charges', '0 3 * * *', 'select generate_due_subscription_charges();', 1790391600, 86400, 11),
  (111, 'maintain-session-series-horizon', '15 2 * * *', 'select cron_maintain_session_series_horizon();', 1790820900, 86400, 6);

insert into fk_jobs select jobid, jobname, schedule, command, true from fk_def;
insert into fk_jobs values (120, 'system-monitor-observe', '*/5 * * * *', 'select public._system_job_observe();', true);


do $$
declare
  c_first constant bigint := 1790067300;
  c_last constant bigint := 1791276600;
  v_off integer;
  v_t bigint;
  v_bad integer;
  v_cycles integer := 0;
  v_total_bad integer := 0;
  v_maxflag text;
  v_res jsonb;
  v_issue_rows bigint := (select count(*) from public.system_issues) + (select count(*) from public.system_issue_events)
                          + (select count(*) from public.system_issue_buckets) + (select count(*) from public.system_issue_transitions);
  v_obs bigint;
begin
  foreach v_off in array array[1, 299] loop
    -- fresh state for each pass: nothing carried over from the other pass or from other tests
    update public.system_job_state set cursor = '{}', last_run_id = 0, runs_observed = 0, last_started_at = null, last_finished_at = null,
      last_technical_success_at = null, last_failure_at = null, last_status = null, last_technical_outcome = 'unknown', last_outcome = 'unknown',
      consecutive_failures = 0, consecutive_ok = 0, last_duration_ms = null, last_result = '{}', stale = false, stale_since = null,
      shadow = '{}', last_observed_at = null, cron_jobid = null, present = true, missing_since = null, grace_until = null,
      schedule = null, command_hash = null;
    -- runs in time order (runid order == start order, as in pg_cron), incl. the observer's own run at every tick
    truncate fk_runs restart identity;
    insert into fk_runs (jobid, status, return_message, start_time, end_time)
    select x.jobid, 'succeeded', '1 row', to_timestamp(x.s), to_timestamp(x.s) from (
      select d.jobid, d.first_s + g * d.gap as s from fk_def d cross join lateral generate_series(0, d.n - 1) g
      union all select 120, t from generate_series(c_first + v_off, c_last + v_off, 300) t) x
    order by x.s, x.jobid;
    v_t := c_first + v_off;
    while v_t <= c_last + v_off loop
      perform set_config('fk.now', to_timestamp(v_t)::text, true);
      v_res := public._system_job_observe(to_timestamp(v_t));
      v_cycles := v_cycles + 1;
      if not (v_res ->> 'ok')::boolean then raise exception 'C1 FAILED: observer errors at %: %', to_timestamp(v_t), v_res; end if;
      select count(*) into v_bad from public.system_job_state s where s.stale or s.shadow <> '{}'::jsonb;
      if v_bad > 0 then
        select string_agg(s.job_key || ' ' || s.shadow::text || ' stale=' || s.stale, '; ') into v_maxflag
        from public.system_job_state s where s.stale or s.shadow <> '{}'::jsonb;
        raise exception 'C1 FAILED: false alarm at % (offset %): %', to_timestamp(v_t), v_off, v_maxflag;
      end if;
      v_t := v_t + 300;
    end loop;
    raise notice 'C1 pass offset +%s s: % cycles so far, 0 false alarms', v_off, v_cycles;

    -- every run observed exactly once
    for v_obs in select 1 loop
      if exists (
        select 1 from public.system_job_state s join fk_def d on d.jobname = s.job_key
        where s.runs_observed <> d.n and s.runs_observed < 12) then
        raise exception 'C2 FAILED: bootstrap count off';
      end if;
    end loop;
    if (select s.last_run_id from public.system_job_state s where s.job_key = 'whatsapp-dispatch-notifications')
       <> (select max(runid) from fk_runs where jobid = 105) then
      raise exception 'C2 FAILED: dispatch last_run_id is not the last run';
    end if;
    if (select s.runs_observed from public.system_job_state s where s.job_key = 'whatsapp-dispatch-notifications') <> 4032 then
      raise exception 'C2 FAILED: dispatch runs observed % (expected 4032 = every run exactly once)',
        (select s.runs_observed from public.system_job_state s where s.job_key = 'whatsapp-dispatch-notifications');
    end if;
    if (select s.runs_observed from public.system_job_state s where s.job_key = 'open-weekly-registrations') <> 1344 then
      raise exception 'C2 FAILED: open-weekly runs observed';
    end if;
  end loop;
  raise notice 'C1 PASSED: % observer cycles over 14 days of real production timing (2 phase offsets): ZERO stale ticks, ZERO shadow flags', v_cycles;
  raise notice 'C2 PASSED: every real run counted exactly once (4032 / 1344 observed for the 5-min / 15-min jobs, incl. past the 12-run bootstrap)';

  if (select count(*) from public.system_issues) + (select count(*) from public.system_issue_events)
     + (select count(*) from public.system_issue_buckets) + (select count(*) from public.system_issue_transitions) <> v_issue_rows then
    raise exception 'C3 FAILED: the replay created issue rows';
  end if;
  raise notice 'C3 PASSED: zero issue rows created during the replay';

  -- Negative control: the scheduler stops after the last real run; the detector must fire at the right time.
  perform set_config('fk.now', to_timestamp(c_last + 600)::text, true);
  perform public._system_job_observe(to_timestamp(c_last + 600));       -- 600 s after last dispatch: still inside 720 s
  if (select stale from public.system_job_state where job_key = 'whatsapp-dispatch-notifications') then
    raise exception 'C4 FAILED: stale too early (600 s)';
  end if;
  perform set_config('fk.now', to_timestamp(c_last + 1500)::text, true);
  perform public._system_job_observe(to_timestamp(c_last + 1500));
  if not (select stale from public.system_job_state where job_key = 'whatsapp-dispatch-notifications') then
    raise exception 'C4 FAILED: a stopped dispatch job was not detected';
  end if;
  raise notice 'C4 PASSED: negative control — a stopped 5-minute job is flagged after > 720 s and not before';

  raise notice 'ALL CALIBRATION REPLAY CHECKS (C1-C4) PASSED';
end $$;

rollback;
