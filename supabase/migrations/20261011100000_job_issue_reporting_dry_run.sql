-- System monitoring, Phase 2.4: job-infrastructure issue reporting + recovery layer (DRY-RUN by default).
--
-- SCOPE: scheduler/infrastructure health only. The observer (Phase 2.1-2.3) already detects, per REGISTERED and
-- MONITORED business job: stale, failed (pg_cron run ended in error), missing, disabled, stuck. This migration adds the
-- layer that turns those persistent conditions into centralized system issues, with deterministic identity,
-- deduplication and automatic recovery. It reports only what is known: "the scheduled job did not run / did not
-- complete", never "the business operation failed" (a successful cron call can still hide an internal failure; that is
-- the deferred business-outcome phase). Unregistered jobs, the observer itself, pg_net downstream failures and
-- application/client failures are NOT reported.
--
-- MODES (config job_monitoring.issue_mode):
--     off      the reporting layer does not run
--     dry_run  the full decision logic runs and its decisions are recorded in system_job_state.reporting, but NOTHING is
--              written to the monitoring issue tables and the ingestion engine is never called
--     live     decisions are executed through the Phase 1 trusted ingestion engine
--   Live requires ALL of: issue_mode='live', report_enabled=true, shadow=false. Any other combination that asks for live
--   runs as dry_run (fail-safe). An absent/unknown issue_mode is 'off'. This migration sets issue_mode='dry_run' and does
--   not change shadow (true) or report_enabled (false). Moving to live later is a config change only (no code deploy).
--
-- IDENTITY: the fingerprint key is  job_health:<job_key>:<condition>  (condition = stale|failed|missing|disabled|stuck),
--   passed as the trusted fingerprint_key. Timestamps, run ids, messages and the observer cycle never influence identity.
--
-- LIFECYCLE (per job and condition, level-triggered and re-evaluated every cycle, so a dropped report is retried):
--     healthy ................................ nothing
--     unhealthy for N consecutive cycles ..... open   (N = issue_open_confirm_cycles, default 2: a one-cycle blip never opens)
--     still unhealthy ........................ refresh at most every issue_refresh_s (default 3600 s): one occurrence per hour,
--                                              which also keeps the engine's volume escalation (10 reports/hour) unreachable
--     healthy for M consecutive cycles ....... resolve (M = issue_resolve_confirm_cycles, default 2) via
--                                              _system_issue_auto_recover (resolution 'auto_recovered', transition 'auto_resolve')
--     unhealthy again after resolution ....... the SAME issue is reopened by the engine's normal rule (auto_reopen, reopen_count,
--                                              flapping escalation after 3 reopens in 30 days). Choice A (reopen) was taken because
--                                              identity is stable and Phase 1 already defines recurrence as a reopen.
--   Conditions never resolve each other: each has its own fingerprint and its own confirm counters. A muted issue is never
--   touched by recovery. Switching the mode changes which "open" records are trusted: a record made in another mode is
--   re-evaluated (dry_run -> live opens real issues on the next confirmed cycle; live -> dry_run leaves real issues as they are).
--
-- SEVERITY: base severity comes from the row (severity_stale / severity_failure; missing and disabled use the higher of the two;
--   stuck uses severity_failure). The row's escalation JSON may raise it (stale: after_s of age since the last start;
--   failed: consecutive_failures >= after); entries carrying only_when_mode are ignored here. The result is then CAPPED AT
--   'error': _system_job_issue_severity() takes least(rank, 3), so 'critical' (rank 4) can never be produced by this layer,
--   whatever the row or escalation JSON contains. The escalation configuration itself is preserved untouched.
--
-- FAILURE SEMANTICS: the reporting step runs in its own exception block inside the observer and each job inside its own block.
--   A reporting failure rolls back only that block's writes (never the job-state detection that was already written in the same
--   transaction), the error is counted in last_result.issue_errors, and the next cycle retries because state only advances
--   after the engine accepts a report. The engine itself never raises (Phase 1 contract).
--
-- UNCHANGED BY DESIGN: the stale thresholds. The two daily jobs keep interval + 7200 s (93600 s), a two-hour margin over their maximum
-- normal age (about 86400 s) observed during the 74-hour production shadow period; the frequent jobs keep 2x interval + 120 s.
--
-- KNOWN LIMITATIONS (out of scope here, tracked for later phases): a successful cron call can hide an internal business failure
-- (billing per-subscription failures, recurring-series per-series failures); pg_net downstream HTTP failures (about 3 percent of the
-- dispatch calls timed out during the shadow review while their cron rows read "succeeded") are not seen; and if the observer or the
-- database scheduler stops entirely, nothing inside this system can alert (an external dead-man check would be needed).
--
-- NO manager notifications exist or are added. No business data is read or written. Definitions + one additive column + config only.

alter table public.system_job_state
  add column if not exists reporting jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reporting) = 'object' and octet_length(reporting::text) <= 8192);

comment on column public.system_job_state.reporting is
  'Phase 2.4 per-condition reporting state (bounded): confirm counters, whether an issue is (would be) open, last action/severity, '
  'action counters. On the observer row: mode, cumulative totals and a ring of the last 20 decisions (the dry-run evidence).';

grant select (reporting) on public.system_job_state to authenticated;

update public.system_monitoring_config
set value = value || jsonb_build_object(
  'issue_mode', 'dry_run',
  'issue_open_confirm_cycles', 2,
  'issue_resolve_confirm_cycles', 2,
  'issue_refresh_s', 3600)
where key = 'job_monitoring' and jsonb_typeof(value) = 'object';

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_jobcfg_text(p_name text, p_default text, p_allowed text[])
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value) = 'object' and jsonb_typeof(c.value -> p_name) = 'string'
                     and (c.value ->> p_name) = any (p_allowed)
                then c.value ->> p_name end
    from public.system_monitoring_config c
    where c.key = 'job_monitoring'
  ), p_default);
$$;

-- Effective reporting mode. live needs issue_mode='live' AND report_enabled AND NOT shadow; otherwise a live request is dry_run.
create or replace function public._system_job_issue_mode()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case public._system_jobcfg_text('issue_mode', 'off', array['off', 'dry_run', 'live'])
    when 'live' then case when public._system_jobcfg_bool('report_enabled', false)
                               and not public._system_jobcfg_bool('shadow', true) then 'live' else 'dry_run' end
    when 'dry_run' then 'dry_run'
    else 'off' end;
$$;

-- Severity for a (job, condition) report. NEVER above 'error' (rank 3): 'critical' cannot be produced by Phase 2.4.
create or replace function public._system_job_issue_severity(p public.system_job_state, p_cond text, p_now timestamptz)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c_cap constant integer := 3;  -- 'error'
  v_rank integer;
  v_esc jsonb;
  v_age numeric;
begin
  v_rank := case p_cond
    when 'stale' then public._system_sev_rank(p.severity_stale)
    when 'failed' then public._system_sev_rank(p.severity_failure)
    when 'stuck' then public._system_sev_rank(p.severity_failure)
    else greatest(public._system_sev_rank(p.severity_stale), public._system_sev_rank(p.severity_failure)) end;
  if v_rank < 1 then v_rank := 2; end if;      -- null / unknown severity text -> warning

  if jsonb_typeof(p.escalation) = 'object' then
    if p_cond = 'stale' then
      v_esc := p.escalation -> 'stale';
      if jsonb_typeof(v_esc) = 'object' and not (v_esc ? 'only_when_mode')
         and jsonb_typeof(v_esc -> 'after_s') = 'number' and (v_esc ->> 'after_s') ~ '^[0-9]{1,9}$' then
        v_age := extract(epoch from (p_now - coalesce(p.last_started_at, p.first_seen_at)));
        if v_age >= (v_esc ->> 'after_s')::numeric and jsonb_typeof(v_esc -> 'severity') = 'string' then
          v_rank := greatest(v_rank, public._system_sev_rank(v_esc ->> 'severity'));
        end if;
      end if;
    elsif p_cond = 'failed' then
      v_esc := p.escalation -> 'failure';
      if jsonb_typeof(v_esc) = 'object' and not (v_esc ? 'only_when_mode')
         and jsonb_typeof(v_esc -> 'after') = 'number' and (v_esc ->> 'after') ~ '^[0-9]{1,9}$' then
        if p.consecutive_failures >= (v_esc ->> 'after')::integer and jsonb_typeof(v_esc -> 'severity') = 'string' then
          v_rank := greatest(v_rank, public._system_sev_rank(v_esc ->> 'severity'));
        end if;
      end if;
    end if;
  end if;

  return public._system_rank_sev(least(v_rank, c_cap));
end;
$$;

-- Stable, factual wording: states only what the scheduler-level evidence proves.
create or replace function public._system_job_issue_message(p_job text, p_cond text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case p_cond
    when 'stale' then format('Scheduled job %s has not started within its expected window.', p_job)
    when 'failed' then format('The last scheduled run of job %s ended with an error at the scheduler level.', p_job)
    when 'missing' then format('Scheduled job %s is not present in the scheduler.', p_job)
    when 'disabled' then format('Scheduled job %s is disabled in the scheduler.', p_job)
    when 'stuck' then format('Scheduled job %s has been running longer than expected.', p_job)
    else format('Scheduled job %s is unhealthy.', p_job) end;
$$;

create or replace function public._system_job_issue_key(p_job text, p_cond text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'job_health:' || p_job || ':' || p_cond;
$$;

create or replace function public._system_job_issue_payload(p public.system_job_state, p_cond text, p_sev text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'source', 'cron',
    'subsystem', p.subsystem,
    'operation', 'cron/' || p.job_key,
    'error_class', 'JobHealth',
    'error_code', 'job_' || p_cond,
    'message', public._system_job_issue_message(p.job_key, p_cond),
    'severity', p_sev,
    'fingerprint_key', public._system_job_issue_key(p.job_key, p_cond),
    'context', jsonb_build_object('job', p.job_key, 'reason', p_cond)
               || case when p_cond = 'failed' then jsonb_build_object('count', least(p.consecutive_failures, 1000000)) else '{}'::jsonb end,
    'count', 1));
$$;

-- Internal recovery: resolve the open/acknowledged issue with this fingerprint key. A muted issue is never touched; a missing
-- issue is not an error. Never raises. Uses the resolution/transition values Phase 1 reserved for automatic recovery.
create or replace function public._system_issue_auto_recover(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
declare
  v_fp text;
  v_i public.system_issues;
begin
  if p_key is null or p_key !~ '^[a-z0-9_:.-]{1,160}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_key');
  end if;
  v_fp := public._system_fingerprint(null, null, null, null, null, null, null, p_key);
  select * into v_i from public.system_issues where fingerprint = v_fp for no key update;
  if not found then
    return jsonb_build_object('ok', true, 'resolved', false, 'reason', 'no_issue');
  end if;
  if v_i.status not in ('open', 'acknowledged') then
    return jsonb_build_object('ok', true, 'resolved', false, 'reason', 'status_' || v_i.status);
  end if;
  update public.system_issues
  set status = 'resolved', resolution = 'auto_recovered', resolved_at = now(), resolved_by = null,
      resolved_version = last_seen_version, muted_until = null
  where id = v_i.id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id, reason)
  values (v_i.id, v_i.status, 'resolved', 'auto_resolve', null, 'auto_recovered');
  return jsonb_build_object('ok', true, 'resolved', true);
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'internal');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The reporting cycle: one pass over the registered, monitored business jobs. Called by the observer after detection.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_job_report_cycle(p_now timestamptz, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_self constant text := 'system-monitor-observe';
  c_conds constant text[] := array['stale', 'failed', 'missing', 'disabled', 'stuck'];
  c_recent_max constant integer := 20;
  v_open_n integer := public._system_jobcfg_int('issue_open_confirm_cycles', 2, 1, 20);
  v_res_n integer := public._system_jobcfg_int('issue_resolve_confirm_cycles', 2, 1, 20);
  v_refresh integer := public._system_jobcfg_int('issue_refresh_s', 3600, 900, 86400);
  r public.system_job_state;
  v_cond text;
  v_active boolean;
  v_all jsonb;
  v_new jsonb;
  v_c jsonb;
  v_rec jsonb;
  v_seen integer;
  v_ok integer;
  v_open boolean;
  v_since text;
  v_rep text;
  v_sev text;
  v_act text;
  v_at text;
  v_n_open integer;
  v_n_upd integer;
  v_n_res integer;
  v_fail integer;
  v_action text;
  v_applied boolean;
  v_resp jsonb;
  v_dec jsonb := '[]'::jsonb;
  v_ts text := to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  t_open integer := 0;
  t_upd integer := 0;
  t_res integer := 0;
  t_fail integer := 0;
  v_obs jsonb;
  v_recent jsonb;
  v_tot jsonb;
begin
  for r in
    select * from public.system_job_state s
    where s.kind = 'pg_cron' and s.registered and s.monitored and s.job_key <> c_self
      and (s.paused_until is null or s.paused_until <= p_now)
    order by s.job_key
  loop
    begin
      v_all := coalesce(r.reporting -> 'c', '{}'::jsonb);
      v_new := v_all;

      foreach v_cond in array c_conds loop
        v_active := case v_cond
          when 'stale' then r.stale
          when 'failed' then r.shadow ? 'would_be_scheduler_failure'
          when 'missing' then r.shadow ? 'would_be_missing'
          when 'disabled' then r.shadow ? 'would_be_disabled'
          when 'stuck' then r.shadow ? 'would_be_stuck' end;
        v_c := coalesce(v_all -> v_cond, '{}'::jsonb);
        continue when not v_active and v_c = '{}'::jsonb;

        v_seen := coalesce((v_c ->> 'seen')::integer, 0);
        v_ok := coalesce((v_c ->> 'ok')::integer, 0);
        v_open := coalesce((v_c ->> 'open')::boolean, false) and coalesce(v_c ->> 'm', '') = p_mode;
        v_since := v_c ->> 'since';
        v_rep := v_c ->> 'rep';
        v_sev := v_c ->> 'sev';
        v_act := v_c ->> 'act';
        v_at := v_c ->> 'at';
        v_n_open := coalesce((v_c ->> 'n_open')::integer, 0);
        v_n_upd := coalesce((v_c ->> 'n_upd')::integer, 0);
        v_n_res := coalesce((v_c ->> 'n_res')::integer, 0);
        v_fail := coalesce((v_c ->> 'fail')::integer, 0);
        v_action := 'noop';

        if v_active then
          v_ok := 0;
          v_seen := least(v_seen + 1, v_open_n);
          if not v_open then
            if v_seen >= v_open_n then v_action := 'open'; end if;
          elsif v_rep is null or p_now - v_rep::timestamptz >= make_interval(secs => v_refresh) then
            v_action := 'update';
          end if;
        else
          v_seen := 0;
          if v_open then
            v_ok := least(v_ok + 1, v_res_n);
            if v_ok >= v_res_n then v_action := 'resolve'; end if;
          else
            v_ok := 0;
          end if;
        end if;

        if v_action in ('open', 'update') then
          v_sev := public._system_job_issue_severity(r, v_cond, p_now);
          v_applied := true;
          if p_mode = 'live' then
            v_resp := public._system_ingest('trusted', public._system_job_issue_payload(r, v_cond, v_sev), null);
            v_applied := coalesce((v_resp ->> 'accepted')::boolean, false) or (v_resp ->> 'reason') = 'ignored';
          end if;
          if v_applied then
            v_open := true;
            v_rep := v_ts;
            v_act := v_action;
            v_at := v_ts;
            if v_action = 'open' then
              v_since := v_ts;
              v_n_open := v_n_open + 1;
              t_open := t_open + 1;
            else
              v_n_upd := v_n_upd + 1;
              t_upd := t_upd + 1;
            end if;
          else
            v_fail := least(v_fail + 1, 1000000);
            t_fail := t_fail + 1;
          end if;
          v_dec := v_dec || jsonb_build_array(jsonb_build_object('t', v_ts, 'j', r.job_key, 'c', v_cond, 'a', v_action,
                                                                  's', v_sev, 'm', p_mode, 'ap', v_applied));
        elsif v_action = 'resolve' then
          v_applied := true;
          if p_mode = 'live' then
            v_resp := public._system_issue_auto_recover(public._system_job_issue_key(r.job_key, v_cond));
            v_applied := coalesce((v_resp ->> 'ok')::boolean, false);
          end if;
          if v_applied then
            v_open := false;
            v_ok := 0;
            v_act := 'resolve';
            v_at := v_ts;
            v_n_res := v_n_res + 1;
            t_res := t_res + 1;
          else
            v_fail := least(v_fail + 1, 1000000);
            t_fail := t_fail + 1;
          end if;
          v_dec := v_dec || jsonb_build_array(jsonb_build_object('t', v_ts, 'j', r.job_key, 'c', v_cond, 'a', 'resolve',
                                                                  's', v_sev, 'm', p_mode, 'ap', v_applied));
        end if;

        v_rec := jsonb_build_object('seen', v_seen, 'ok', v_ok, 'open', v_open, 'm', p_mode,
                                    'n_open', v_n_open, 'n_upd', v_n_upd, 'n_res', v_n_res, 'fail', v_fail)
                 || case when v_sev is not null then jsonb_build_object('sev', v_sev) else '{}'::jsonb end
                 || case when v_act is not null then jsonb_build_object('act', v_act) else '{}'::jsonb end
                 || case when v_at is not null then jsonb_build_object('at', v_at) else '{}'::jsonb end
                 || case when v_since is not null then jsonb_build_object('since', v_since) else '{}'::jsonb end
                 || case when v_rep is not null then jsonb_build_object('rep', v_rep) else '{}'::jsonb end
                 || jsonb_build_object('fp', public._system_job_issue_key(r.job_key, v_cond));
        v_new := v_new || jsonb_build_object(v_cond, v_rec);
      end loop;

      if v_new is distinct from v_all then
        update public.system_job_state s
        set reporting = jsonb_build_object('c', v_new), updated_at = p_now
        where s.job_key = r.job_key;
      end if;
    exception when others then
      -- this job's block (including any engine writes it made) is rolled back; the other jobs and the detection state are unaffected
      t_fail := t_fail + 1;
      raise warning 'system job issue reporting failed for one job (sqlstate %)', sqlstate;
    end;
  end loop;

  -- Dry-run evidence / cumulative totals live on the observer's own row (bounded ring of the last 20 decisions).
  select s.reporting into v_obs from public.system_job_state s where s.job_key = c_self;
  v_obs := coalesce(v_obs, '{}'::jsonb);
  if jsonb_array_length(v_dec) > 0 or coalesce(v_obs ->> 'mode', '') <> p_mode then
    v_tot := coalesce(v_obs -> 'totals', '{}'::jsonb);
    v_recent := (
      select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb)
      from (
        select x.value, x.ord from jsonb_array_elements(v_dec || coalesce(v_obs -> 'recent', '[]'::jsonb)) with ordinality as x(value, ord)
        order by x.ord limit c_recent_max
      ) e
    );
    update public.system_job_state s
    set reporting = jsonb_build_object(
          'mode', p_mode,
          'totals', jsonb_build_object(
            'open', coalesce((v_tot ->> 'open')::integer, 0) + t_open,
            'update', coalesce((v_tot ->> 'update')::integer, 0) + t_upd,
            'resolve', coalesce((v_tot ->> 'resolve')::integer, 0) + t_res,
            'fail', coalesce((v_tot ->> 'fail')::integer, 0) + t_fail),
          'recent', v_recent),
        updated_at = p_now
    where s.job_key = c_self;
  end if;

  return jsonb_build_object('mode', p_mode, 'open', t_open, 'update', t_upd, 'resolve', t_res, 'fail', t_fail);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The observer (Phase 2.1-2.3 body, unchanged except step 5b and the extra last_result keys).
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_job_observe(p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '1s'
as $$
declare
  c_self constant text := 'system-monitor-observe';
  v_now timestamptz := coalesce(p_now, now());
  v_t0 timestamptz := clock_timestamp();
  v_hw bigint;
  v_new_hw bigint;
  v_hold bigint;
  v_max_runs integer;
  v_learn_min integer;
  v_grace integer;
  v_stuck_min integer;
  v_stuck_mult integer;
  v_down_min integer;
  v_paused timestamptz;
  v_report_seen boolean;
  v_ids bigint[];
  r record;
  rr record;
  js public.system_job_state;
  n_jobs integer := 0;
  n_runs integer := 0;
  n_skipped integer := 0;
  n_unmapped integer := 0;
  n_inflight integer := 0;
  n_boot integer := 0;
  n_errors integer := 0;
  v_changed boolean;
  v_churn boolean;
  v_dur integer;
  v_gaps integer[];
  v_med integer;
  v_down boolean;
  v_issue_mode text := 'off';
  v_issue_rep jsonb := '{}'::jsonb;
  n_issue_err integer := 0;
  -- bootstrap scratch
  v_k integer;
  v_starts double precision[];
  v_streak integer;
  v_streak_open boolean;
  v_last_id bigint;
  v_last_start timestamptz;
  v_last_end timestamptz;
  v_last_status text;
  v_last_dur integer;
  v_last_ok timestamptz;
  v_last_fail timestamptz;
  v_last_fail_msg text;
  v_infl_id bigint;
  v_infl_start timestamptz;
  v_cur jsonb;
  i integer;
begin
  -- Overlap protection: a second observer returns immediately without touching anything.
  if not pg_try_advisory_xact_lock(hashtext('shira.system_job_observe')) then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  begin
    if not public._system_jobcfg_bool('observer_enabled', true) then
      return jsonb_build_object('ok', true, 'disabled', true);
    end if;

    v_max_runs := public._system_jobcfg_int('max_runs_per_cycle', 2000, 100, 20000);
    v_learn_min := public._system_jobcfg_int('learn_min_runs', 3, 2, 50);
    v_grace := public._system_jobcfg_int('stale_grace_s', 120, 0, 3600);
    v_stuck_min := public._system_jobcfg_int('stuck_min_s', 600, 60, 86400);
    v_stuck_mult := public._system_jobcfg_int('stuck_duration_multiple', 20, 2, 1000);
    v_down_min := public._system_jobcfg_int('scheduler_down_min_jobs', 3, 2, 20);
    v_paused := public._system_jobcfg_paused_until();
    -- recorded only: this version of the observer has no reporting code path at all
    v_report_seen := public._system_jobcfg_bool('report_enabled', false);

    -- The observer's own row must exist (seeded by migration; recreated defensively).
    insert into public.system_job_state (job_key, subsystem, criticality, registered, monitored, expected_interval_s,
                                         interval_source, stale_after_s, recovery_runs, first_seen_at, updated_at)
    values (c_self, 'monitoring', 'monitor', true, true, 300, 'configured', 1020, 2, v_now, v_now)
    on conflict (job_key) do nothing;

    select (s.cursor ->> 'run_id')::bigint into v_hw from public.system_job_state s where s.job_key = c_self;
    -- first cycle ever: take the high-water mark BEFORE bootstrapping so no run can fall between the two
    if v_hw is null then
      v_hw := public._system_cron_max_runid();
    end if;
    v_new_hw := v_hw;
    v_hold := null;

    -- ===================== step 1: registry sync (cron.job -> system_job_state) =====================
    begin
      for r in
        select c.jobid, public._system_job_key(c.jobname, c.jobid) as job_key, c.schedule, md5(c.command) as command_hash,
               c.active, s.job_key as s_key, s.cron_jobid as s_jobid, s.schedule as s_schedule, s.command_hash as s_hash,
               s.interval_source as s_isrc, s.expected_interval_s as s_interval
        from public._system_cron_jobs() c
        left join public.system_job_state s on s.job_key = public._system_job_key(c.jobname, c.jobid)
      loop
        n_jobs := n_jobs + 1;
        if r.s_key is null then
          -- a job nobody has registered: auto-discovered, learned cadence, one hour of grace
          insert into public.system_job_state (job_key, cron_jobid, schedule, command_hash, active, present, registered,
                                               monitored, criticality, subsystem, interval_source, grace_until, shadow,
                                               first_seen_at, last_observed_at, updated_at)
          values (r.job_key, r.jobid, r.schedule, r.command_hash, r.active, true, false, true, 'standard', 'cron',
                  'unknown', v_now + interval '1 hour', jsonb_build_object('would_be_unregistered', v_now::text),
                  v_now, v_now, v_now)
          on conflict (job_key) do nothing;
        else
          v_changed := (r.s_hash is not null and r.s_hash is distinct from r.command_hash)
                    or (r.s_schedule is not null and r.s_schedule is distinct from r.schedule);
          v_churn := r.s_jobid is not null and r.s_jobid is distinct from r.jobid;
          update public.system_job_state s set
            cron_jobid = r.jobid,
            schedule = r.schedule,
            command_hash = r.command_hash,
            active = r.active,
            present = true,
            missing_since = null,
            grace_until = case when v_changed
                               then v_now + make_interval(secs => greatest(coalesce(s.expected_interval_s, 0), 600))
                               else s.grace_until end,
            shadow = s.shadow
              || case when v_changed then jsonb_build_object(
                   'definition_changes', coalesce((s.shadow ->> 'definition_changes')::integer, 0) + 1,
                   'last_definition_change_at', v_now::text) else '{}'::jsonb end
              || case when v_churn then jsonb_build_object(
                   'jobid_changes', coalesce((s.shadow ->> 'jobid_changes')::integer, 0) + 1,
                   'last_jobid_change_at', v_now::text) else '{}'::jsonb end,
            -- a LEARNED cadence is discarded when the definition changed; configured ones are kept
            interval_source = case when v_changed and s.interval_source = 'learned' then 'unknown' else s.interval_source end,
            expected_interval_s = case when v_changed and s.interval_source = 'learned' then null else s.expected_interval_s end,
            stale_after_s = case when v_changed and s.interval_source = 'learned' then null else s.stale_after_s end,
            cursor = case when v_changed and s.interval_source = 'learned' then s.cursor - 'gaps' else s.cursor end,
            updated_at = v_now
          where s.job_key = r.job_key
            and (s.cron_jobid is distinct from r.jobid or s.schedule is distinct from r.schedule
                 or s.command_hash is distinct from r.command_hash or s.active is distinct from r.active
                 or s.present is not true or s.missing_since is not null);
        end if;
      end loop;

      -- jobs that were there and are gone
      update public.system_job_state s
      set present = false, missing_since = coalesce(s.missing_since, v_now), updated_at = v_now
      where s.kind = 'pg_cron' and s.present
        and not exists (select 1 from public._system_cron_jobs() c where public._system_job_key(c.jobname, c.jobid) = s.job_key);
    exception when others then
      n_errors := n_errors + 1;
      raise warning 'system job observer: registry sync failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 2: one-time bootstrap per job (history -> initial state) =====================
    begin
      for js in
        select * from public.system_job_state s
        where s.kind = 'pg_cron' and s.cron_jobid is not null and s.present and not (s.cursor ? 'bootstrapped')
        order by s.job_key
      loop
        n_boot := n_boot + 1;
        v_k := 0; v_starts := '{}'; v_streak := 0; v_streak_open := true;
        v_last_id := null; v_last_start := null; v_last_end := null; v_last_status := null; v_last_dur := null;
        v_last_ok := null; v_last_fail := null; v_last_fail_msg := null; v_infl_id := null; v_infl_start := null;
        for rr in select * from public._system_cron_recent_runs(js.cron_jobid, 12) loop
          if rr.status in ('succeeded', 'failed') then
            v_k := v_k + 1;
            if v_k = 1 then
              v_last_id := rr.runid; v_last_start := rr.start_time; v_last_end := rr.end_time; v_last_status := rr.status;
              if rr.end_time is not null and rr.start_time is not null then
                v_last_dur := least(2147483647, greatest(0, (extract(epoch from (rr.end_time - rr.start_time)) * 1000)::bigint))::integer;
              end if;
            end if;
            if rr.status = 'succeeded' and v_last_ok is null then
              v_last_ok := coalesce(rr.end_time, rr.start_time);
            end if;
            if rr.status = 'failed' and v_last_fail is null then
              v_last_fail := coalesce(rr.end_time, rr.start_time);
              v_last_fail_msg := rr.return_message;
            end if;
            if v_streak_open then
              if rr.status = v_last_status then v_streak := v_streak + 1; else v_streak_open := false; end if;
            end if;
            v_starts := v_starts || extract(epoch from rr.start_time)::double precision;
          elsif v_k = 0 and v_infl_id is null then
            v_infl_id := rr.runid; v_infl_start := rr.start_time;
          end if;
        end loop;
        -- gaps between consecutive starts, oldest first, at most 7
        v_gaps := '{}';
        for i in reverse (cardinality(v_starts) - 1)..1 loop
          if v_starts[i] - v_starts[i + 1] > 0 then
            v_gaps := v_gaps || least(2147483647, (v_starts[i] - v_starts[i + 1])::bigint)::integer;
          end if;
        end loop;
        if cardinality(v_gaps) > 7 then
          v_gaps := v_gaps[cardinality(v_gaps) - 6:cardinality(v_gaps)];
        end if;
        v_cur := js.cursor || jsonb_build_object('bootstrapped', true, 'gaps', to_jsonb(v_gaps));
        if v_infl_id is not null then
          v_cur := v_cur || jsonb_build_object('inflight', jsonb_build_object('run_id', v_infl_id, 'started_at', v_infl_start::text));
        end if;
        update public.system_job_state s set
          last_run_id = coalesce(v_last_id, s.last_run_id),
          runs_observed = v_k,
          last_started_at = coalesce(v_last_start, s.last_started_at),
          last_finished_at = coalesce(v_last_end, s.last_finished_at),
          last_technical_success_at = coalesce(v_last_ok, s.last_technical_success_at),
          last_failure_at = coalesce(v_last_fail, s.last_failure_at),
          last_status = coalesce(v_last_status, s.last_status),
          last_technical_outcome = case when v_last_status = 'succeeded' then 'success'
                                        when v_last_status = 'failed' then 'failed' else s.last_technical_outcome end,
          last_outcome = case when v_last_status = 'failed' then 'hard_failure' else s.last_outcome end,
          consecutive_failures = case when v_last_status = 'failed' then v_streak else 0 end,
          consecutive_ok = case when v_last_status = 'succeeded' then v_streak else 0 end,
          last_duration_ms = coalesce(v_last_dur, s.last_duration_ms),
          last_result = case when v_last_status = 'failed'
                             then jsonb_build_object('run_id', v_last_id, 'status', 'failed',
                                                     'message', coalesce(public._system_redact(v_last_fail_msg, 160), ''))
                             else s.last_result end,
          cursor = v_cur,
          updated_at = v_now
        where s.job_key = js.job_key;
      end loop;
    exception when others then
      n_errors := n_errors + 1;
      raise warning 'system job observer: bootstrap failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 3: ingest new runs and revisit in-flight ones =====================
    begin
      select coalesce(array_agg((s.cursor -> 'inflight' ->> 'run_id')::bigint), '{}'::bigint[]) into v_ids
      from public.system_job_state s where s.cursor ? 'inflight';

      for r in select * from public._system_cron_runs(v_hw, v_ids, v_max_runs) loop
        n_runs := n_runs + 1;
        v_new_hw := greatest(v_new_hw, r.runid);
        select * into js from public.system_job_state s where s.kind = 'pg_cron' and s.cron_jobid = r.jobid limit 1;
        if not found then
          n_unmapped := n_unmapped + 1;
          continue;
        end if;

        if r.status not in ('succeeded', 'failed') then
          -- still running
          if js.job_key = c_self then
            -- the observer's own current run: hold the high-water mark so it is re-read once it has finished
            v_hold := least(coalesce(v_hold, r.runid - 1), r.runid - 1);
          else
            n_inflight := n_inflight + 1;
            update public.system_job_state s
            set cursor = s.cursor || jsonb_build_object('inflight', jsonb_build_object('run_id', r.runid, 'started_at', r.start_time::text)),
                updated_at = v_now
            where s.job_key = js.job_key and (s.cursor -> 'inflight' ->> 'run_id') is distinct from r.runid::text;
          end if;
          continue;
        end if;

        if r.runid <= js.last_run_id then
          -- already counted (bootstrap or an earlier cycle); just drop a stale in-flight marker
          n_skipped := n_skipped + 1;
          if (js.cursor -> 'inflight' ->> 'run_id') = r.runid::text then
            update public.system_job_state s set cursor = s.cursor - 'inflight', updated_at = v_now where s.job_key = js.job_key;
          end if;
          continue;
        end if;

        -- a new terminal run
        v_dur := null;
        if r.end_time is not null and r.start_time is not null then
          v_dur := least(2147483647, greatest(0, (extract(epoch from (r.end_time - r.start_time)) * 1000)::bigint))::integer;
        end if;
        v_gaps := coalesce(array(select jsonb_array_elements_text(js.cursor -> 'gaps')::integer), '{}'::integer[]);
        if js.last_started_at is not null and r.start_time > js.last_started_at then
          v_gaps := v_gaps || least(2147483647, extract(epoch from (r.start_time - js.last_started_at))::bigint)::integer;
          if cardinality(v_gaps) > 7 then
            v_gaps := v_gaps[cardinality(v_gaps) - 6:cardinality(v_gaps)];
          end if;
        end if;
        v_cur := (case when (js.cursor -> 'inflight' ->> 'run_id') = r.runid::text then js.cursor - 'inflight' else js.cursor end)
                 || jsonb_build_object('gaps', to_jsonb(v_gaps));

        if r.status = 'succeeded' then
          update public.system_job_state s set
            last_run_id = r.runid,
            runs_observed = least(s.runs_observed + 1, 1000000),
            last_started_at = r.start_time,
            last_finished_at = r.end_time,
            last_status = r.status,
            last_duration_ms = v_dur,
            last_technical_success_at = coalesce(r.end_time, r.start_time),
            last_technical_outcome = 'success',
            consecutive_ok = least(s.consecutive_ok + 1, 1000000),
            consecutive_failures = 0,
            -- business success is NOT known for an uninstrumented job: never fabricated here
            last_outcome = case when s.last_outcome = 'hard_failure' then 'unknown' else s.last_outcome end,
            last_result = case when s.last_outcome = 'hard_failure' then '{}'::jsonb else s.last_result end,
            cursor = v_cur,
            updated_at = v_now
          where s.job_key = js.job_key;
        else
          update public.system_job_state s set
            last_run_id = r.runid,
            runs_observed = least(s.runs_observed + 1, 1000000),
            last_started_at = r.start_time,
            last_finished_at = r.end_time,
            last_status = r.status,
            last_duration_ms = v_dur,
            last_failure_at = coalesce(r.end_time, r.start_time),
            last_technical_outcome = 'failed',
            consecutive_failures = least(s.consecutive_failures + 1, 1000000),
            consecutive_ok = 0,
            last_outcome = 'hard_failure',
            last_result = jsonb_build_object('run_id', r.runid, 'status', 'failed',
                                             'message', coalesce(public._system_redact(r.return_message, 160), '')),
            cursor = v_cur,
            updated_at = v_now
          where s.job_key = js.job_key;
        end if;
      end loop;
    exception when others then
      n_errors := n_errors + 1;
      raise warning 'system job observer: run ingestion failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 4: learn the cadence of unregistered / unknown jobs =====================
    begin
      for js in
        select * from public.system_job_state s
        where s.kind = 'pg_cron' and s.interval_source <> 'configured' and s.cursor ? 'gaps' and s.runs_observed >= v_learn_min
      loop
        v_gaps := coalesce(array(select jsonb_array_elements_text(js.cursor -> 'gaps')::integer), '{}'::integer[]);
        if cardinality(v_gaps) >= v_learn_min - 1 then
          select percentile_disc(0.5) within group (order by g)::integer into v_med from unnest(v_gaps) g;
          if v_med between 10 and 604800 then
            update public.system_job_state s set
              expected_interval_s = v_med, interval_source = 'learned',
              stale_after_s = public._system_job_stale_after_s(v_med, v_grace), updated_at = v_now
            where s.job_key = js.job_key
              and (s.expected_interval_s is distinct from v_med or s.interval_source <> 'learned');
          end if;
        end if;
      end loop;
    exception when others then
      n_errors := n_errors + 1;
      raise warning 'system job observer: interval learning failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 5: shadow flags (stale / missing / disabled / stuck / failure) =====================
    begin
      with c1 as (
        select s.job_key,
               greatest(s.last_started_at, (s.cursor -> 'inflight' ->> 'started_at')::timestamptz) as last_seen_start,
               (s.monitored and s.job_key <> c_self
                 and (s.paused_until is null or s.paused_until <= v_now)
                 and (s.grace_until is null or s.grace_until <= v_now)
                 and (v_paused is null or v_paused <= v_now)) as evaluable
        from public.system_job_state s
        where s.kind = 'pg_cron'
      ), c2 as (
        select s.job_key,
               (c1.evaluable and s.present and s.active and s.expected_interval_s is not null and s.stale_after_s is not null
                 and c1.last_seen_start is not null
                 and v_now - c1.last_seen_start > make_interval(secs => s.stale_after_s)) as new_stale,
               (s.monitored and s.registered and not s.present) as f_missing,
               (s.monitored and s.registered and s.present and not s.active) as f_disabled,
               (s.present and not s.registered) as f_unregistered,
               (c1.evaluable and s.cursor ? 'inflight'
                 and v_now - (s.cursor -> 'inflight' ->> 'started_at')::timestamptz
                     > make_interval(secs => greatest(v_stuck_min, v_stuck_mult * coalesce(s.last_duration_ms, 0) / 1000.0))) as f_stuck,
               (s.monitored and (s.consecutive_failures >= 1
                                 or (s.shadow ? 'would_be_scheduler_failure' and s.consecutive_ok < s.recovery_runs))) as f_failure
        from public.system_job_state s join c1 on c1.job_key = s.job_key
      ), c3 as (
        select s.job_key, c2.new_stale,
               ((s.shadow - 'would_be_stale' - 'would_be_missing' - 'would_be_disabled' - 'would_be_unregistered'
                          - 'would_be_stuck' - 'would_be_scheduler_failure')
                 || case when c2.new_stale then jsonb_build_object('would_be_stale', coalesce(s.shadow ->> 'would_be_stale', v_now::text)) else '{}'::jsonb end
                 || case when c2.f_missing then jsonb_build_object('would_be_missing', coalesce(s.shadow ->> 'would_be_missing', coalesce(s.missing_since, v_now)::text)) else '{}'::jsonb end
                 || case when c2.f_disabled then jsonb_build_object('would_be_disabled', coalesce(s.shadow ->> 'would_be_disabled', v_now::text)) else '{}'::jsonb end
                 || case when c2.f_unregistered then jsonb_build_object('would_be_unregistered', coalesce(s.shadow ->> 'would_be_unregistered', v_now::text)) else '{}'::jsonb end
                 || case when c2.f_stuck then jsonb_build_object('would_be_stuck', coalesce(s.shadow ->> 'would_be_stuck', v_now::text)) else '{}'::jsonb end
                 || case when c2.f_failure then jsonb_build_object('would_be_scheduler_failure', coalesce(s.shadow ->> 'would_be_scheduler_failure', coalesce(s.last_failure_at, v_now)::text)) else '{}'::jsonb end
               ) as new_shadow
        from public.system_job_state s join c2 on c2.job_key = s.job_key
      )
      update public.system_job_state s set
        stale = c3.new_stale,
        stale_since = case when c3.new_stale then coalesce(s.stale_since, v_now) else null end,
        shadow = c3.new_shadow,
        updated_at = v_now
      from c3
      where s.job_key = c3.job_key and (s.stale is distinct from c3.new_stale or s.shadow is distinct from c3.new_shadow);

      -- correlated outage: several frequent jobs stale at once looks like a scheduler outage (shadow flag only)
      select count(*) >= v_down_min into v_down
      from public.system_job_state s
      where s.kind = 'pg_cron' and s.stale and s.expected_interval_s <= 3600 and s.job_key <> c_self;
      update public.system_job_state s set
        shadow = case when v_down then (s.shadow || jsonb_build_object('would_be_scheduler_down', coalesce(s.shadow ->> 'would_be_scheduler_down', v_now::text)))
                      else s.shadow - 'would_be_scheduler_down' end,
        updated_at = v_now
      where s.job_key = c_self
        and ((v_down and not (s.shadow ? 'would_be_scheduler_down')) or (not v_down and s.shadow ? 'would_be_scheduler_down'));
    exception when others then
      n_errors := n_errors + 1;
      raise warning 'system job observer: shadow flags failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 5b: issue reporting layer (Phase 2.4) =====================
    -- Own exception block: a failure here rolls back only this step's writes, never the detection state written above, and is
    -- counted in last_result.issue_errors. In dry_run the engine is never called and no monitoring row is written.
    begin
      v_issue_mode := public._system_job_issue_mode();
      if v_issue_mode <> 'off' and (v_paused is null or v_paused <= v_now) then
        v_issue_rep := public._system_job_report_cycle(v_now, v_issue_mode);
        n_issue_err := coalesce((v_issue_rep ->> 'fail')::integer, 0);
      end if;
    exception when others then
      n_errors := n_errors + 1;
      n_issue_err := n_issue_err + 1;
      raise warning 'system job observer: issue reporting failed (sqlstate %)', sqlstate;
    end;

    -- ===================== step 6: heartbeat + cursor (this row is the only one touched every cycle) =====================
    update public.system_job_state s set
      last_observed_at = v_now,
      last_result = jsonb_build_object(
        'ok', n_errors = 0, 'jobs', n_jobs, 'runs', n_runs, 'skipped', n_skipped, 'unmapped', n_unmapped,
        'inflight', n_inflight, 'bootstrapped', n_boot, 'errors', n_errors, 'hw', least(v_new_hw, coalesce(v_hold, v_new_hw)),
        'report_enabled_seen', v_report_seen,
        'issue_mode', v_issue_mode, 'issue', jsonb_build_object('o', coalesce((v_issue_rep ->> 'open')::integer, 0), 'u', coalesce((v_issue_rep ->> 'update')::integer, 0), 'r', coalesce((v_issue_rep ->> 'resolve')::integer, 0), 'e', n_issue_err),
        'ms', (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::integer),
      cursor = s.cursor || jsonb_build_object('run_id', least(v_new_hw, coalesce(v_hold, v_new_hw)), 'bootstrapped', true),
      updated_at = v_now
    where s.job_key = c_self;

    return jsonb_build_object('ok', n_errors = 0, 'jobs', n_jobs, 'runs', n_runs, 'errors', n_errors, 'bootstrapped', n_boot);
  exception when others then
    raise warning 'system job observer failed (sqlstate %): %', sqlstate, left(sqlerrm, 200);
    -- re-raised on purpose: pg_cron then records this job as failed, which is the independent signal
    raise;
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: every function here is internal. Revoke every default grant.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_system_jobcfg_text', '_system_job_issue_mode', '_system_job_issue_severity', '_system_job_issue_message',
                        '_system_job_issue_key', '_system_job_issue_payload', '_system_issue_auto_recover',
                        '_system_job_report_cycle', '_system_job_observe')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- Self-check.
do $$
declare
  r record;
  v_role text;
  v_n integer := 0;
  v_probe public.system_job_state;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_system_jobcfg_text', '_system_job_issue_mode', '_system_job_issue_severity', '_system_job_issue_message',
                        '_system_job_issue_key', '_system_job_issue_payload', '_system_issue_auto_recover',
                        '_system_job_report_cycle', '_system_job_observe')
  loop
    v_n := v_n + 1;
    if r.owner <> 'postgres' then raise exception 'self-check: % is not owned by postgres', r.sig; end if;
    if r.proconfig is null or not ('search_path=public, pg_temp' = any (r.proconfig)) then
      raise exception 'self-check: % does not pin search_path', r.sig;
    end if;
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        raise exception 'self-check: % is executable by %', r.sig, v_role;
      end if;
    end loop;
  end loop;
  if v_n <> 9 then raise exception 'self-check: expected 9 functions, found %', v_n; end if;
  if public._system_job_issue_mode() <> 'dry_run' then
    raise exception 'self-check: Phase 2.4 must start in dry_run, effective mode is %', public._system_job_issue_mode();
  end if;
  if not has_column_privilege('authenticated', 'public.system_job_state'::regclass, 'reporting', 'SELECT')
     or has_column_privilege('authenticated', 'public.system_job_state'::regclass, 'reporting', 'INSERT,UPDATE') then
    raise exception 'self-check: unexpected privileges on system_job_state.reporting';
  end if;
  v_probe := json_populate_record(null::public.system_job_state,
    '{"job_key":"probe","severity_stale":"critical","severity_failure":"critical","consecutive_failures":9,
      "escalation":{"stale":{"after_s":1,"severity":"critical"},"failure":{"after":1,"severity":"critical"}}}'::json);
  if public._system_job_issue_severity(v_probe, 'stale', now()) <> 'error'
     or public._system_job_issue_severity(v_probe, 'failed', now()) <> 'error'
     or public._system_job_issue_severity(v_probe, 'missing', now()) <> 'error' then
    raise exception 'self-check: severity cap failed';
  end if;
end $$;
