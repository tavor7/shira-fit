-- Close a monitoring gap: genuine series-horizon-generation and reconcile failures were
-- already logged to the Activity Log (series_horizon_generation_failed /
-- series_horizon_reconcile_failed, via _insert_activity_event), but never reached the
-- System Issues dashboard. Investigation found two independent reasons:
--   1) Nothing in the codebase reads user_activity_events and writes system_issues -- the
--      two pipelines are disjoint.
--   2) The only existing link between this cron job and System Issues is the Phase 2.4
--      scheduler-level job-health layer (_system_job_report_cycle), which only observes
--      whether the pg_cron job itself started/finished/errored -- not whether it logged
--      internal per-series business failures while still returning {ok: true} -- and that
--      layer is still in dry_run (see 20261011100000_job_issue_reporting_dry_run.sql). This
--      migration does not touch that layer, its dry_run setting, or any cron schedule.
--
-- Fix: report genuine failures directly from _maintain_session_series_horizon_core(), using
-- the EXISTING trusted ingestion entry point (_report_system_error -> _system_ingest('trusted',
-- ...) -> system_issues), with no new reporting pipeline:
--   - _report_system_error is SECURITY DEFINER, catches all of its own errors and never
--     raises (see 20261006120000_system_monitoring_ingest_lifecycle.sql) -- a reporting
--     failure can never interrupt or change the result of session generation.
--   - a stable p_fingerprint_key ('series_horizon_generation_failed:<series_id>' /
--     'series_horizon_reconcile_failed') makes _system_fingerprint hash just that key, so
--     repeated occurrences of the SAME cause update the SAME system_issues row (occurrence
--     count, last_seen) instead of creating a new one each time -- using the fingerprinting
--     and dedup semantics _system_ingest_impl already has, not a new ad hoc scheme.
--   - only reached from the existing `exception when others` branches, i.e. only for
--     failures that were NOT recognized and handled by _generate_series_occurrence_claim
--     (created / already_handled / series_logical_conflict / series_slot_conflict /
--     series_date_already_occupied all return normally and never enter these branches) --
--     harmless, successfully-handled conflicts are never reported as issues.
--   - client-side technical reporting (report_client_error) and the client_ingest_enabled /
--     Phase 2.4 issue_mode flags are untouched; this calls the trusted internal path only.
--
-- No existing training_sessions, session_series, registration, attendance, or payment row is
-- modified by this migration. It only redefines one function (adds two calls inside existing
-- exception handlers; everything else is byte-identical to the prior version).
create or replace function public._maintain_session_series_horizon_core()
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_from date;
  v_to date;
  v_total int := 0;
  v_failed int := 0;
  v_reconciled int := 0;
  v_unresolved int := 0;
  slot record;
  s record;
  v_d date;
  v_n int;
  v_end date;
  v_owner_series_id uuid;
  v_candidates uuid[];
  v_outcome text;
  cleared_key text;
  cleared jsonb := '{}'::jsonb;  -- set of "series_id|date" strings cleared to claim
begin
  v_from := public._studio_today_date();
  v_to := public._series_horizon_end();

  -- Pass 1 (read-only): for every distinct (coach, start_time) slot family among active
  -- ongoing series, and every candidate date in the horizon, determine ownership BEFORE any
  -- series attempts to claim anything.
  for slot in
    select distinct coach_id, start_time
    from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    for v_d in
      select generate_series(v_from, v_to, interval '1 day')::date
    loop
      -- Case A: an owner already exists for this exact template slot+date (from backfill, a
      -- prior run, or a prior edit) -- nothing to resolve, the owning series proceeds normally
      -- via its own loop below.
      select o.series_id into v_owner_series_id
      from public.session_series_occurrences o
      where o.template_coach_id = slot.coach_id
        and o.template_start_time = slot.start_time
        and o.template_occurrence_date = v_d;

      if v_owner_series_id is not null then
        cleared := cleared || jsonb_build_object(v_owner_series_id::text || '|' || v_d::text, true);
        continue;
      end if;

      -- No owner yet. Who, among this slot family's active series, actually wants this date?
      select array_agg(ss.id) into v_candidates
      from public.session_series ss
      where ss.coach_id = slot.coach_id
        and ss.start_time = slot.start_time
        and ss.status = 'active'
        and ss.repeat_mode = 'ongoing'::public.session_series_repeat_mode
        and v_d >= ss.anchor_date
        and mod((v_d - ss.anchor_date), 7) = 0
        and not (v_d = any (coalesce(ss.skip_dates, '{}'::date[])))
        and (ss.ended_from_date is null or v_d < ss.ended_from_date);

      if v_candidates is null or array_length(v_candidates, 1) = 0 then
        continue;  -- nobody wants this date
      elsif array_length(v_candidates, 1) = 1 then
        cleared := cleared || jsonb_build_object(v_candidates[1]::text || '|' || v_d::text, true);
      else
        v_unresolved := v_unresolved + 1;
        perform public._insert_activity_event(
          null, 'series_unresolved_ownership', 'session_series', null,
          jsonb_build_object(
            'template_coach_id', slot.coach_id,
            'template_start_time', slot.start_time,
            'template_occurrence_date', v_d,
            'candidate_series_ids', to_jsonb(v_candidates)
          )
        );
        -- neither candidate is cleared; no claim attempted for anyone on this date
      end if;
    end loop;
  end loop;

  -- Pass 2: per-series generation, claiming only dates cleared in pass 1. Per-series exception
  -- isolation unchanged from the prior hardening migration.
  for s in
    select * from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    begin
      v_end := v_to;
      if s.ended_from_date is not null then
        v_end := least(v_to, s.ended_from_date - 1);
      end if;

      v_n := 0;
      while true loop
        v_d := s.anchor_date + (v_n * 7);
        exit when v_d > v_end;
        v_n := v_n + 1;

        continue when v_d < v_from;
        continue when v_d = any (coalesce(s.skip_dates, '{}'::date[]));
        cleared_key := s.id::text || '|' || v_d::text;
        continue when not coalesce((cleared -> cleared_key)::boolean, false);

        v_outcome := public._generate_series_occurrence_claim(s.id, v_d);
        if v_outcome = 'created' then
          v_total := v_total + 1;
        end if;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      perform public._insert_activity_event(
        null, 'series_horizon_generation_failed', 'session_series', s.id::text,
        jsonb_build_object(
          'operation', 'maintain_session_series_horizon', 'error', sqlerrm,
          'sqlstate', sqlstate, 'occurred_at', now()
        )
      );
      -- Best-effort System Issues report, existing trusted entry point. Never raises: a
      -- reporting failure cannot interrupt or change the result of horizon generation.
      perform public._report_system_error(
        p_source := 'cron',
        p_subsystem := 'recurring_sessions',
        p_operation := 'maintain_session_series_horizon',
        p_error_class := 'unhandled_unique_violation',
        p_error_code := sqlstate,
        p_message := sqlerrm,
        p_severity := 'error',
        p_entities := jsonb_build_object('series_id', s.id),
        p_context := jsonb_build_object('occurred_at', now()),
        p_fingerprint_key := 'series_horizon_generation_failed:' || s.id::text,
        p_count := 1,
        p_origin := 'maintain_session_series_horizon'
      );
    end;
  end loop;

  begin
    v_reconciled := public._reconcile_slot_duplicate_sessions();
  exception when others then
    perform public._insert_activity_event(
      null, 'series_horizon_reconcile_failed', 'session_series', null,
      jsonb_build_object(
        'operation', 'reconcile_series_duplicate_sessions', 'error', sqlerrm,
        'sqlstate', sqlstate, 'occurred_at', now()
      )
    );
    perform public._report_system_error(
      p_source := 'cron',
      p_subsystem := 'recurring_sessions',
      p_operation := 'reconcile_series_duplicate_sessions',
      p_error_class := 'unhandled_error',
      p_error_code := sqlstate,
      p_message := sqlerrm,
      p_severity := 'error',
      p_entities := '{}'::jsonb,
      p_context := jsonb_build_object('occurred_at', now()),
      p_fingerprint_key := 'series_horizon_reconcile_failed',
      p_count := 1,
      p_origin := 'maintain_session_series_horizon'
    );
  end;

  return json_build_object(
    'ok', true, 'created', v_total, 'reconciled', v_reconciled,
    'failed', v_failed, 'unresolved_ownership', v_unresolved
  );
end;
$$;
