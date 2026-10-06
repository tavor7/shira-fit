-- System monitoring Phase 2.2: observer behaviour tests (shadow mode), driven by SYNTHETIC scheduler data.
--
-- The four cron adapters are replaced inside this transaction by readers of temp tables (the whole test is
-- rolled back), and the observer is called with an explicit "now". Covers: successful runs (state updated,
-- zero issues), idempotency, hard failure, repeated failures, recovery, stale + recovery, disabled, missing,
-- monitored=false, job-id churn, changed schedule (grace), changed command, new unregistered job + learning,
-- in-flight revisit (counted once), unknown business outcome, observer step failure isolation, the paused
-- switch, shadow-only behaviour (no issue/event/bucket/transition rows ever), and the redaction of messages.
set client_min_messages to notice;
begin;

create temp table fk_jobs (jobid bigint primary key, jobname text, schedule text, command text, active boolean default true);
create temp table fk_runs (runid bigint generated always as identity primary key, jobid bigint, status text, return_message text,
                           start_time timestamptz, end_time timestamptz);
create temp table fk_counts (k text primary key, v bigint);
create temp table fk_fail (on_runs boolean default false);
insert into fk_fail values (false);

create or replace function public._system_cron_jobs()
returns table (jobid bigint, jobname text, schedule text, command text, active boolean)
language sql stable set search_path = public, pg_temp
as $$ select j.jobid, j.jobname, j.schedule, j.command, j.active from pg_temp.fk_jobs j $$;

create or replace function public._system_cron_max_runid()
returns bigint language sql stable set search_path = public, pg_temp
as $$ select coalesce(max(r.runid), 0)::bigint from pg_temp.fk_runs r $$;

create or replace function public._system_cron_runs(p_after bigint, p_ids bigint[], p_limit integer)
returns table (runid bigint, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language plpgsql stable set search_path = public, pg_temp
as $$
begin
  if (select on_runs from pg_temp.fk_fail) then raise exception 'synthetic adapter failure'; end if;
  return query select r.runid, r.jobid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
    where r.runid > coalesce(p_after, 0) or r.runid = any (coalesce(p_ids, '{}'::bigint[])) order by r.runid limit p_limit;
end $$;

create or replace function public._system_cron_recent_runs(p_jobid bigint, p_n integer)
returns table (runid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql stable set search_path = public, pg_temp
as $$ select r.runid, r.status, r.return_message, r.start_time, r.end_time from pg_temp.fk_runs r
      where r.jobid = p_jobid order by r.runid desc limit p_n $$;

create function pg_temp.fk_run(p_jobid bigint, p_start timestamptz, p_status text default 'succeeded', p_msg text default '1 row', p_dur_s integer default 1)
returns bigint language sql as $$
  insert into pg_temp.fk_runs (jobid, status, return_message, start_time, end_time)
  values (p_jobid, p_status, p_msg, p_start, case when p_status in ('succeeded', 'failed') then p_start + make_interval(secs => p_dur_s) end)
  returning runid
$$;

-- Regular history for a job: n runs ending at p_last, one every p_every seconds.
create function pg_temp.fk_history(p_jobid bigint, p_last timestamptz, p_every integer, p_n integer) returns void language plpgsql as $$
declare i integer;
begin
  for i in reverse (p_n - 1)..0 loop
    perform pg_temp.fk_run(p_jobid, p_last - make_interval(secs => i * p_every));
  end loop;
end $$;

create function pg_temp.fk_st(p_key text) returns public.system_job_state language sql as $$
  select s from public.system_job_state s where s.job_key = p_key
$$;

create function pg_temp.fk_issue_rows() returns bigint language sql as $$
  select (select count(*) from public.system_issues) + (select count(*) from public.system_issue_events)
       + (select count(*) from public.system_issue_buckets) + (select count(*) from public.system_issue_transitions)
$$;

do $$
declare
  t0 constant timestamptz := '2026-10-01 12:00:00+00';
  v_issue_rows bigint := pg_temp.fk_issue_rows();
  v_res jsonb;
  v_s public.system_job_state;
  v_id bigint;
  v_run bigint;
  v_biz_before text;
  v_cfg jsonb;
begin
  -- Fixture: the seven production jobs (note the ids deliberately differ from production) + the observer.
  insert into fk_jobs values
    (104, 'whatsapp-session-reminders', '*/30 * * * *', 'select enqueue_due_session_reminder_whatsapp();', true),
    (105, 'whatsapp-dispatch-notifications', '*/5 * * * *', 'select invoke_dispatch_notifications_edge();', true),
    (106, 'birthday-direct-messages', '0 * * * *', 'select send_due_birthday_messages();', true),
    (107, 'push-session-reminders', '*/15 * * * *', 'select dispatch_due_session_push_reminders();', true),
    (108, 'open-weekly-registrations', '*/15 * * * *', 'select open_next_week_sessions_if_due_core();', true),
    (109, 'generate-subscription-charges', '0 3 * * *', 'select generate_due_subscription_charges();', true),
    (111, 'maintain-session-series-horizon', '15 2 * * *', 'select cron_maintain_session_series_horizon();', true),
    (120, 'system-monitor-observe', '*/5 * * * *', 'select public._system_job_observe();', true);
  -- aligned to the clock: last run is "just now" for every job
  perform pg_temp.fk_history(104, t0 - interval '10 minutes', 1800, 12);
  perform pg_temp.fk_history(105, t0 - interval '1 minute', 300, 40);
  perform pg_temp.fk_history(106, t0, 3600, 12);
  perform pg_temp.fk_history(107, t0 - interval '5 minutes', 900, 12);
  perform pg_temp.fk_history(108, t0 - interval '5 minutes', 900, 12);
  perform pg_temp.fk_history(109, t0 - interval '9 hours', 86400, 5);
  perform pg_temp.fk_history(111, t0 - interval '9 hours 45 minutes', 86400, 5);
  perform pg_temp.fk_history(120, t0 - interval '2 minutes', 300, 12);

  -- O1: first cycle bootstraps from history; zero issues; nothing stale; business outcome unknown.
  v_res := public._system_job_observe(t0);
  if not (v_res ->> 'ok')::boolean or (v_res ->> 'bootstrapped')::int <> 8 or (v_res ->> 'jobs')::int <> 8 then
    raise exception 'O1 FAILED: first cycle result %', v_res;
  end if;
  if exists (select 1 from public.system_job_state where stale or shadow <> '{}'::jsonb) then
    raise exception 'O1 FAILED: something is stale/flagged after a healthy first cycle: %',
      (select jsonb_agg(jsonb_build_object(s.job_key, s.shadow)) from public.system_job_state s where stale or shadow <> '{}'::jsonb);
  end if;
  v_s := pg_temp.fk_st('whatsapp-dispatch-notifications');
  if v_s.cron_jobid <> 105 or v_s.runs_observed <> 12 or v_s.last_technical_outcome <> 'success'
     or v_s.last_technical_success_at is null or v_s.consecutive_ok <> 12 then
    raise exception 'O1 FAILED: dispatch state %', to_jsonb(v_s);
  end if;
  if v_s.last_outcome <> 'unknown' or v_s.last_business_success_at is not null then
    raise exception 'O1 FAILED: business outcome must stay unknown / never fabricated: %', to_jsonb(v_s);
  end if;
  if pg_temp.fk_issue_rows() <> v_issue_rows then raise exception 'O1 FAILED: issue rows were created'; end if;
  if (pg_temp.fk_st('system-monitor-observe')).last_observed_at <> t0 or ((pg_temp.fk_st('system-monitor-observe')).cursor ->> 'run_id')::bigint
       <> (select max(runid) from fk_runs) then
    raise exception 'O1 FAILED: heartbeat / cursor not advanced: %', to_jsonb(pg_temp.fk_st('system-monitor-observe'));
  end if;
  raise notice 'O1 PASSED: bootstrap from history, 8 jobs, nothing stale, business outcome unknown, zero issue rows';

  -- O2: idempotent — nothing new => nothing counted twice.
  v_res := public._system_job_observe(t0 + interval '30 seconds');
  if (v_res ->> 'runs')::int <> 0 or (pg_temp.fk_st('whatsapp-dispatch-notifications')).runs_observed <> 12 then
    raise exception 'O2 FAILED: re-observation counted runs: %', v_res;
  end if;
  raise notice 'O2 PASSED: a second observation with no new runs changes no counters';

  -- O3: new successful runs are counted exactly once, durations recorded, intervals untouched (configured).
  v_run := pg_temp.fk_run(105, t0 + interval '4 minutes', 'succeeded', '1 row', 2);
  v_res := public._system_job_observe(t0 + interval '5 minutes');
  v_s := pg_temp.fk_st('whatsapp-dispatch-notifications');
  if v_s.runs_observed <> 13 or v_s.last_run_id <> v_run or v_s.last_duration_ms <> 2000 or v_s.expected_interval_s <> 300
     or v_s.interval_source <> 'configured' then
    raise exception 'O3 FAILED: %', to_jsonb(v_s);
  end if;
  raise notice 'O3 PASSED: new run counted once; configured interval preserved';

  -- O4: hard failure -> failure recorded, shadow flag, message redacted + bounded; repeated failures counted.
  v_run := pg_temp.fk_run(107, t0 + interval '10 minutes', 'failed', 'ERROR: boom for jane.doe@example.com token=abcdef0123456789abcdef0123456789 ' || repeat('x', 400), 1);
  perform public._system_job_observe(t0 + interval '11 minutes');
  v_s := pg_temp.fk_st('push-session-reminders');
  if v_s.consecutive_failures <> 1 or v_s.last_technical_outcome <> 'failed' or v_s.last_outcome <> 'hard_failure'
     or not (v_s.shadow ? 'would_be_scheduler_failure') or v_s.last_failure_at is null then
    raise exception 'O4 FAILED: %', to_jsonb(v_s);
  end if;
  if v_s.last_result::text ~ 'jane\.doe@example\.com' or v_s.last_result::text ~ 'abcdef0123456789abcdef0123456789'
     or octet_length(v_s.last_result::text) > 512 then
    raise exception 'O4 FAILED: failure message not redacted/bounded: %', v_s.last_result;
  end if;
  perform pg_temp.fk_run(107, t0 + interval '25 minutes', 'failed', 'again', 1);
  perform pg_temp.fk_run(107, t0 + interval '40 minutes', 'failed', 'again', 1);
  perform public._system_job_observe(t0 + interval '41 minutes');
  if (pg_temp.fk_st('push-session-reminders')).consecutive_failures <> 3 then raise exception 'O4 FAILED: repeated failures not counted'; end if;
  raise notice 'O4 PASSED: hard failure + repeated failures recorded; message redacted and bounded; shadow flag only';

  -- O5: recovery needs recovery_runs (2) consecutive successes before the shadow flag clears.
  perform pg_temp.fk_run(107, t0 + interval '55 minutes');
  perform public._system_job_observe(t0 + interval '56 minutes');
  v_s := pg_temp.fk_st('push-session-reminders');
  if v_s.consecutive_failures <> 0 or v_s.consecutive_ok <> 1 or not (v_s.shadow ? 'would_be_scheduler_failure') then
    raise exception 'O5 FAILED: flag must persist until 2 successes: %', to_jsonb(v_s);
  end if;
  perform pg_temp.fk_run(107, t0 + interval '70 minutes');
  perform public._system_job_observe(t0 + interval '71 minutes');
  v_s := pg_temp.fk_st('push-session-reminders');
  if v_s.shadow ? 'would_be_scheduler_failure' or v_s.last_outcome <> 'unknown' or v_s.last_business_success_at is not null then
    raise exception 'O5 FAILED: recovery not applied: %', to_jsonb(v_s);
  end if;
  raise notice 'O5 PASSED: recovery after consecutive successes; business outcome back to unknown, never "ok"';

  -- Everything is healthy again as of t0+71m for the frequent jobs: add runs so only the dispatch job is stale.
  -- O6: stale detection (dispatch: interval 300 s, stale_after 720 s) and recovery.
  perform pg_temp.fk_run(104, t0 + interval '70 minutes'); perform pg_temp.fk_run(106, t0 + interval '60 minutes');
  perform pg_temp.fk_run(108, t0 + interval '70 minutes'); perform pg_temp.fk_run(120, t0 + interval '70 minutes');
  perform pg_temp.fk_run(105, t0 + interval '69 minutes');
  perform public._system_job_observe(t0 + interval '80 minutes');   -- dispatch last start 69m => 11m = 660s <= 720 : not stale
  if (pg_temp.fk_st('whatsapp-dispatch-notifications')).stale then raise exception 'O6 FAILED: stale at 660 s'; end if;
  perform public._system_job_observe(t0 + interval '82 minutes');   -- 13m = 780 s > 720 : stale
  v_s := pg_temp.fk_st('whatsapp-dispatch-notifications');
  if not v_s.stale or v_s.stale_since is null or not (v_s.shadow ? 'would_be_stale') then
    raise exception 'O6 FAILED: stale not detected: %', to_jsonb(v_s);
  end if;
  perform pg_temp.fk_run(105, t0 + interval '83 minutes');
  perform public._system_job_observe(t0 + interval '84 minutes');
  v_s := pg_temp.fk_st('whatsapp-dispatch-notifications');
  if v_s.stale or v_s.stale_since is not null or v_s.shadow ? 'would_be_stale' then
    raise exception 'O6 FAILED: stale not cleared by a new run: %', to_jsonb(v_s);
  end if;
  -- the slow job (daily) is not stale after a normal day and not flagged by a single hour of lateness
  if (pg_temp.fk_st('generate-subscription-charges')).stale then raise exception 'O6 FAILED: daily job flagged stale early'; end if;
  raise notice 'O6 PASSED: stale at > stale_after_s (660 s ok, 780 s stale), cleared by the next run';

  -- O7: disabled job -> would_be_disabled (and never "stale"); re-enable clears it.
  update fk_jobs set active = false where jobid = 106;
  perform public._system_job_observe(t0 + interval '9 hours');
  v_s := pg_temp.fk_st('birthday-direct-messages');
  if v_s.active or not (v_s.shadow ? 'would_be_disabled') or v_s.stale then
    raise exception 'O7 FAILED: %', to_jsonb(v_s);
  end if;
  update fk_jobs set active = true where jobid = 106;
  perform pg_temp.fk_run(106, t0 + interval '9 hours 1 minute');
  perform public._system_job_observe(t0 + interval '9 hours 2 minutes');
  if (pg_temp.fk_st('birthday-direct-messages')).shadow ? 'would_be_disabled' then raise exception 'O7 FAILED: not cleared'; end if;
  raise notice 'O7 PASSED: disabled job flagged (not stale); cleared on re-enable';

  -- O8: missing job -> would_be_missing; monitored=false is the planned-removal switch (no flag); config is
  -- the source of truth (a muted issue could never make this intentional - no issue exists at all).
  delete from fk_jobs where jobid = 111;
  perform public._system_job_observe(t0 + interval '9 hours 5 minutes');
  v_s := pg_temp.fk_st('maintain-session-series-horizon');
  if v_s.present or v_s.missing_since is null or not (v_s.shadow ? 'would_be_missing') then
    raise exception 'O8 FAILED: missing not detected: %', to_jsonb(v_s);
  end if;
  update public.system_job_state set monitored = false where job_key = 'maintain-session-series-horizon';
  perform public._system_job_observe(t0 + interval '9 hours 10 minutes');
  if (pg_temp.fk_st('maintain-session-series-horizon')).shadow ? 'would_be_missing' then
    raise exception 'O8 FAILED: monitored=false must suppress the flag';
  end if;
  update public.system_job_state set monitored = true where job_key = 'maintain-session-series-horizon';
  insert into fk_jobs values (111, 'maintain-session-series-horizon', '15 2 * * *', 'select cron_maintain_session_series_horizon();', true);
  perform public._system_job_observe(t0 + interval '9 hours 15 minutes');
  v_s := pg_temp.fk_st('maintain-session-series-horizon');
  if not v_s.present or v_s.missing_since is not null or v_s.shadow ? 'would_be_missing' then
    raise exception 'O8 FAILED: reappearance not recognised: %', to_jsonb(v_s);
  end if;
  raise notice 'O8 PASSED: missing detected; monitored=false is the explicit removal mechanism; reappearance clears it';

  -- O9: job-id churn (unschedule + schedule gives a new id): state follows the NAME, no "missing", no reset.
  v_s := pg_temp.fk_st('open-weekly-registrations');
  update fk_jobs set jobid = 999 where jobid = 108;
  perform pg_temp.fk_run(999, t0 + interval '9 hours 20 minutes');
  perform public._system_job_observe(t0 + interval '9 hours 21 minutes');
  v_s := pg_temp.fk_st('open-weekly-registrations');
  if v_s.cron_jobid <> 999 or not v_s.present or v_s.missing_since is not null or (v_s.shadow ->> 'jobid_changes')::int <> 1
     or v_s.runs_observed < 13 or v_s.last_started_at <> t0 + interval '9 hours 20 minutes' then
    raise exception 'O9 FAILED: %', to_jsonb(v_s);
  end if;
  if (select count(*) from public.system_job_state where job_key like 'open-weekly%' or job_key like 'job\_%') <> 1 then
    raise exception 'O9 FAILED: a duplicate row was created for the re-scheduled job';
  end if;
  raise notice 'O9 PASSED: job-id churn follows the stable name (no duplicate row, no false missing, counters kept)';

  -- O10: schedule change -> grace window + counted change; configured interval kept. Command change counted.
  update fk_jobs set schedule = '*/30 * * * *' where jobid = 999;
  perform public._system_job_observe(t0 + interval '9 hours 25 minutes');
  v_s := pg_temp.fk_st('open-weekly-registrations');
  if v_s.grace_until <= t0 + interval '9 hours 25 minutes' or (v_s.shadow ->> 'definition_changes')::int <> 1
     or v_s.schedule <> '*/30 * * * *' or v_s.expected_interval_s <> 900 then
    raise exception 'O10 FAILED (schedule): %', to_jsonb(v_s);
  end if;
  -- inside the grace window nothing is flagged stale even with no runs
  perform public._system_job_observe(t0 + interval '9 hours 50 minutes');
  if (pg_temp.fk_st('open-weekly-registrations')).stale then raise exception 'O10 FAILED: stale inside the grace window'; end if;
  update fk_jobs set command = 'select something_else();' where jobid = 999;
  perform public._system_job_observe(t0 + interval '9 hours 52 minutes');
  if ((pg_temp.fk_st('open-weekly-registrations')).shadow ->> 'definition_changes')::int <> 2 then
    raise exception 'O10 FAILED: command change not counted';
  end if;
  update fk_jobs set schedule = '*/15 * * * *', command = 'select open_next_week_sessions_if_due_core();' where jobid = 999;
  raise notice 'O10 PASSED: schedule/command changes counted; grace window prevents stale; configured interval kept';

  -- O11: an unregistered job is auto-discovered (INFO-level shadow flag), cadence learned from its runs.
  insert into fk_jobs values (500, 'surprise-job', '*/10 * * * *', 'select 1;', true);
  perform public._system_job_observe(t0 + interval '10 hours');
  v_s := pg_temp.fk_st('surprise-job');
  if v_s.registered or not v_s.monitored or v_s.criticality <> 'standard' or not (v_s.shadow ? 'would_be_unregistered')
     or v_s.interval_source <> 'unknown' or v_s.grace_until is null then
    raise exception 'O11 FAILED: discovery %', to_jsonb(v_s);
  end if;
  perform pg_temp.fk_run(500, t0 + interval '10 hours 1 minute');
  perform pg_temp.fk_run(500, t0 + interval '10 hours 11 minutes');
  perform pg_temp.fk_run(500, t0 + interval '10 hours 21 minutes');
  perform public._system_job_observe(t0 + interval '10 hours 22 minutes');
  v_s := pg_temp.fk_st('surprise-job');
  if v_s.interval_source <> 'learned' or v_s.expected_interval_s <> 600 or v_s.stale_after_s <> 1320 then
    raise exception 'O11 FAILED: cadence not learned: %', to_jsonb(v_s);
  end if;
  raise notice 'O11 PASSED: unregistered job discovered, flagged would_be_unregistered, cadence learned (600 s, stale after 1320 s)';

  -- O12: in-flight runs are revisited and counted exactly once when they finish (pg_cron updates in place).
  v_id := pg_temp.fk_run(500, t0 + interval '10 hours 31 minutes', 'running', null, 0);
  v_res := public._system_job_observe(t0 + interval '10 hours 31 minutes 30 seconds');
  v_s := pg_temp.fk_st('surprise-job');
  if (v_s.cursor -> 'inflight' ->> 'run_id')::bigint <> v_id or (v_res ->> 'inflight')::int <> 1 then
    raise exception 'O12 FAILED: in-flight not tracked: %', to_jsonb(v_s);
  end if;
  v_run := v_s.runs_observed;
  update fk_runs set status = 'succeeded', end_time = start_time + interval '3 seconds', return_message = '1 row' where runid = v_id;
  perform public._system_job_observe(t0 + interval '10 hours 32 minutes');
  perform public._system_job_observe(t0 + interval '10 hours 33 minutes');
  v_s := pg_temp.fk_st('surprise-job');
  if v_s.runs_observed <> v_run + 1 or v_s.cursor ? 'inflight' or v_s.last_run_id <> v_id then
    raise exception 'O12 FAILED: finished in-flight run counted wrongly: %', to_jsonb(v_s);
  end if;
  -- a stuck run (running far beyond max(stuck_min_s, 20 x last duration)) is flagged
  v_id := pg_temp.fk_run(500, t0 + interval '10 hours 40 minutes', 'running', null, 0);
  perform public._system_job_observe(t0 + interval '10 hours 41 minutes');
  if (pg_temp.fk_st('surprise-job')).shadow ? 'would_be_stuck' then raise exception 'O12 FAILED: flagged stuck too early'; end if;
  perform public._system_job_observe(t0 + interval '11 hours 5 minutes');
  if not ((pg_temp.fk_st('surprise-job')).shadow ? 'would_be_stuck') then raise exception 'O12 FAILED: stuck run not flagged'; end if;
  update fk_runs set status = 'succeeded', end_time = start_time + interval '15 minutes' where runid = v_id;
  perform public._system_job_observe(t0 + interval '11 hours 6 minutes');
  if (pg_temp.fk_st('surprise-job')).shadow ? 'would_be_stuck' then raise exception 'O12 FAILED: stuck flag not cleared'; end if;
  raise notice 'O12 PASSED: in-flight run tracked, counted exactly once when finished; stuck run flagged and cleared';

  -- O13: the observer's own running row never loops: hold the high-water mark so it is re-read.
  v_id := pg_temp.fk_run(120, t0 + interval '11 hours 10 minutes', 'running', null, 0);
  perform public._system_job_observe(t0 + interval '11 hours 10 minutes');
  if ((pg_temp.fk_st('system-monitor-observe')).cursor ->> 'run_id')::bigint >= v_id then
    raise exception 'O13 FAILED: high-water mark moved past the observer''s own in-flight run';
  end if;
  update fk_runs set status = 'succeeded', end_time = start_time + interval '1 second' where runid = v_id;
  perform public._system_job_observe(t0 + interval '11 hours 15 minutes');
  v_s := pg_temp.fk_st('system-monitor-observe');
  if v_s.last_run_id <> v_id then raise exception 'O13 FAILED: own run not recorded: %', to_jsonb(v_s); end if;
  raise notice 'O13 PASSED: the observer''s own in-flight run is re-read after it finishes';

  -- O14: correlated outage (>= 3 frequent jobs stale at once) -> shadow flag on the observer row only.
  perform public._system_job_observe(t0 + interval '30 hours');
  v_s := pg_temp.fk_st('system-monitor-observe');
  if not (v_s.shadow ? 'would_be_scheduler_down') then raise exception 'O14 FAILED: %', to_jsonb(v_s); end if;
  raise notice 'O14 PASSED: several simultaneously stale frequent jobs raise would_be_scheduler_down';

  -- O15: pause switches. paused_until in config suppresses all stale evaluation; observer_enabled=false is a no-op.
  select value into v_cfg from public.system_monitoring_config where key = 'job_monitoring';
  update public.system_monitoring_config set value = value || jsonb_build_object('paused_until', (t0 + interval '40 hours')::text)
   where key = 'job_monitoring';
  perform public._system_job_observe(t0 + interval '31 hours');
  if exists (select 1 from public.system_job_state where stale) then raise exception 'O15 FAILED: paused_until did not suppress stale'; end if;
  update public.system_monitoring_config set value = v_cfg || jsonb_build_object('observer_enabled', false) where key = 'job_monitoring';
  v_res := public._system_job_observe(t0 + interval '32 hours');
  if not (v_res ->> 'disabled')::boolean then raise exception 'O15 FAILED: observer_enabled=false ignored'; end if;
  update public.system_monitoring_config set value = v_cfg where key = 'job_monitoring';
  raise notice 'O15 PASSED: paused_until suppresses stale evaluation; observer_enabled=false is a no-op';

  -- O16: failure isolation. A broken scheduler read is contained per step (counted, not raised); the heartbeat
  -- still advances and the other state survives.
  update fk_fail set on_runs = true;
  v_res := public._system_job_observe(t0 + interval '33 hours');
  if (v_res ->> 'errors')::int < 1 or (v_res ->> 'ok')::boolean then raise exception 'O16 FAILED: error not reported: %', v_res; end if;
  if (pg_temp.fk_st('system-monitor-observe')).last_observed_at <> t0 + interval '33 hours' then
    raise exception 'O16 FAILED: heartbeat not written after a contained step failure';
  end if;
  update fk_fail set on_runs = false;
  -- malformed configuration falls back to defaults rather than failing
  update public.system_monitoring_config set value = '{"stale_grace_s":"abc","learn_min_runs":-5,"paused_until":"garbage"}'::jsonb where key = 'job_monitoring';
  v_res := public._system_job_observe(t0 + interval '33 hours 5 minutes');
  if not (v_res ->> 'ok')::boolean then raise exception 'O16 FAILED: malformed config broke the observer: %', v_res; end if;
  update public.system_monitoring_config set value = v_cfg where key = 'job_monitoring';
  raise notice 'O16 PASSED: contained step failure keeps the heartbeat; malformed config falls back to defaults';

  -- O17: shadow mode never creates issue/event/bucket/transition rows and never touches business-side state.
  if pg_temp.fk_issue_rows() <> v_issue_rows then raise exception 'O17 FAILED: the observer created monitoring issue rows'; end if;
  if exists (select 1 from public.system_job_state where last_business_success_at is not null) then
    raise exception 'O17 FAILED: last_business_success_at fabricated';
  end if;
  if (select value ->> 'report_enabled' from public.system_monitoring_config where key = 'job_monitoring') <> 'false' then
    raise exception 'O17 FAILED: report_enabled changed';
  end if;
  if pg_get_functiondef('public._system_job_observe(timestamptz)'::regprocedure) ~* '_system_ingest|_report_system_error|system_report_trusted|net\.http|vault\.|execute '
  then
    raise exception 'O17 FAILED: the observer references an issue-creating / pg_net / vault / dynamic-SQL path';
  end if;
  raise notice 'O17 PASSED: zero issue rows after the full scenario; no reporting, pg_net, Vault or dynamic SQL path in the observer';

  raise notice 'ALL SYSTEM JOB OBSERVER TESTS (O1-O17) PASSED';
end $$;

rollback;
