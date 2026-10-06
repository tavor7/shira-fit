-- System monitoring, Phase 2.2: the job observer (shadow mode).
--
-- _system_job_observe() reads pg_cron's own scheduler history (cron.job, cron.job_run_details) through four
-- tiny adapter functions and maintains public.system_job_state. SHADOW MODE: it creates NO monitoring
-- issues, resolves nothing, and does not touch pg_net, Vault, notification tables or any business object.
-- There is deliberately no code path in this function that calls the ingestion engine; enabling reporting
-- in a later phase replaces this function. Configuration key job_monitoring.report_enabled is only
-- recorded (never acted on) here.
--
-- Fail-safe properties:
--   * Reads only. It never writes to the cron schema, never alters a job, never calls a business function.
--   * A transaction-level advisory lock makes overlapping runs skip (a second observer returns at once).
--   * Function-level lock_timeout (1s): a contended monitoring row aborts the OBSERVER, never a business job
--     (business jobs do not touch system_job_state).
--   * An unexpected error is logged and RE-RAISED, so pg_cron records this job as failed: that is the
--     independent signal; step-level errors are counted in last_result instead.
--
-- All functions are internal: owned by postgres, pinned search_path, EXECUTE revoked from PUBLIC, anon,
-- authenticated and service_role. The adapters exist so tests can feed synthetic scheduler data.

-- ---------------------------------------------------------------------------------------------
-- Configuration helpers (plain SQL, no exception sub-blocks).
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_jobcfg_int(p_name text, p_default integer, p_min integer, p_max integer)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value) = 'object' then
             case when jsonb_typeof(c.value -> p_name) = 'number' then
               case when (c.value ->> p_name) ~ '^[0-9]{1,9}$' then
                 case when (c.value ->> p_name)::numeric between p_min and p_max then (c.value ->> p_name)::integer end
               end
             end
           end
    from public.system_monitoring_config c
    where c.key = 'job_monitoring'
  ), p_default);
$$;

create or replace function public._system_jobcfg_bool(p_name text, p_default boolean)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value) = 'object' and jsonb_typeof(c.value -> p_name) = 'boolean'
                then (c.value ->> p_name)::boolean end
    from public.system_monitoring_config c
    where c.key = 'job_monitoring'
  ), p_default);
$$;

-- paused_until from config; NULL unless it is a well-formed timestamp string.
create or replace function public._system_jobcfg_paused_until()
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select (
    select case when jsonb_typeof(c.value) = 'object' and jsonb_typeof(c.value -> 'paused_until') = 'string'
                     and (c.value ->> 'paused_until') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]{5,15}(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'
                then (c.value ->> 'paused_until')::timestamptz end
    from public.system_monitoring_config c
    where c.key = 'job_monitoring'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Pure helpers.
-- ---------------------------------------------------------------------------------------------
-- Stable job key: the pg_cron job NAME (lower-cased, restricted charset); unnamed jobs become job_<id>.
create or replace function public._system_job_key(p_name text, p_id bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(
    case
      when nullif(btrim(p_name), '') is null then 'job_' || p_id::text
      when regexp_replace(lower(btrim(p_name)), '[^a-z0-9_.:-]+', '_', 'g') ~ '^[a-z0-9]'
        then regexp_replace(lower(btrim(p_name)), '[^a-z0-9_.:-]+', '_', 'g')
      else 'job_' || regexp_replace(lower(btrim(p_name)), '[^a-z0-9_.:-]+', '_', 'g')
    end, 80);
$$;

-- Stale threshold for an interval: slow jobs (>= 6h) interval + 2h; frequent jobs 2 x interval + grace.
create or replace function public._system_job_stale_after_s(p_interval integer, p_grace integer default 120)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_interval is null or p_interval <= 0 then null
    when p_interval >= 21600 then p_interval + 7200
    else 2 * p_interval + greatest(coalesce(p_grace, 120), 0)
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Scheduler adapters (read-only views of the cron schema).
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_cron_jobs()
returns table (jobid bigint, jobname text, schedule text, command text, active boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select j.jobid, j.jobname::text, j.schedule::text, j.command::text, j.active from cron.job j;
$$;

create or replace function public._system_cron_max_runid()
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(max(d.runid), 0)::bigint from cron.job_run_details d;
$$;

-- Runs after a high-water mark, plus specific in-flight run ids (their status is updated in place by pg_cron).
create or replace function public._system_cron_runs(p_after bigint, p_ids bigint[], p_limit integer)
returns table (runid bigint, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select d.runid, d.jobid, d.status::text, d.return_message::text, d.start_time, d.end_time
  from cron.job_run_details d
  where d.runid > coalesce(p_after, 0) or d.runid = any (coalesce(p_ids, '{}'::bigint[]))
  order by d.runid
  limit greatest(coalesce(p_limit, 1000), 1);
$$;

-- Newest runs of one job (primary-key walk backwards; used once per job for the initial bootstrap).
create or replace function public._system_cron_recent_runs(p_jobid bigint, p_n integer)
returns table (runid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select d.runid, d.status::text, d.return_message::text, d.start_time, d.end_time
  from cron.job_run_details d
  where d.jobid = p_jobid
  order by d.runid desc
  limit greatest(coalesce(p_n, 10), 1);
$$;

-- ---------------------------------------------------------------------------------------------
-- The observer.
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

    -- ===================== step 6: heartbeat + cursor (this row is the only one touched every cycle) =====================
    update public.system_job_state s set
      last_observed_at = v_now,
      last_result = jsonb_build_object(
        'ok', n_errors = 0, 'jobs', n_jobs, 'runs', n_runs, 'skipped', n_skipped, 'unmapped', n_unmapped,
        'inflight', n_inflight, 'bootstrapped', n_boot, 'errors', n_errors, 'hw', least(v_new_hw, coalesce(v_hold, v_new_hw)),
        'report_enabled_seen', v_report_seen, 'ms', (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::integer),
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
      and p.proname in (
        '_system_jobcfg_int', '_system_jobcfg_bool', '_system_jobcfg_paused_until', '_system_job_key',
        '_system_job_stale_after_s', '_system_cron_jobs', '_system_cron_max_runid', '_system_cron_runs',
        '_system_cron_recent_runs', '_system_job_observe')
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
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        '_system_jobcfg_int', '_system_jobcfg_bool', '_system_jobcfg_paused_until', '_system_job_key',
        '_system_job_stale_after_s', '_system_cron_jobs', '_system_cron_max_runid', '_system_cron_runs',
        '_system_cron_recent_runs', '_system_job_observe')
  loop
    v_n := v_n + 1;
    if r.owner <> 'postgres' then raise exception 'self-check: % is not owned by postgres', r.sig; end if;
    if r.proconfig is null or not ('search_path=public, pg_temp' = any (r.proconfig)) then
      raise exception 'self-check: % does not pin search_path', r.sig;
    end if;
    if r.prosecdef <> (r.proname = '_system_job_observe') then
      raise exception 'self-check: % has the wrong SECURITY mode', r.sig;
    end if;
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        raise exception 'self-check: % is executable by %', r.sig, v_role;
      end if;
    end loop;
  end loop;
  if v_n <> 10 then raise exception 'self-check: expected 10 observer functions, found %', v_n; end if;
end $$;
