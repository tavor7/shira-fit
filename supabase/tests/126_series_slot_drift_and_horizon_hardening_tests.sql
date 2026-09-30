-- Regression tests for the series-slot-drift fix and horizon hardening
-- (20260930120000_fix_series_slot_drift_and_harden_horizon.sql).
--
-- Root cause covered: "this occurrence only" edits that changed start_time/coach_id
-- (without changing session_date) left the vacated template slot unprotected, so the
-- next horizon run recreated the original "ghost" occurrence. Also covers per-series
-- exception isolation in maintain_session_series_horizon() and the backfill invariant.
--
-- Uses its own fixtures (manager + 2 coaches) so it does not depend on fixture tables
-- created by earlier numbered test files.
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach1 uuid := gen_random_uuid();
  v_coach2 uuid := gen_random_uuid();

  v_series_a uuid; v_sess_a uuid; v_res json;
  v_series_b uuid; v_sess_b uuid;
  v_series_c uuid; v_sess_c uuid;
  v_series_d uuid; v_sess_d uuid;
  v_series_e uuid; v_sess_e uuid;
  v_series_f uuid;
  v_series_g_ok uuid; v_series_g_bad uuid; v_bad_occ uuid;
  v_skip date[];
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'series126_manager', 'Series Test Manager', '0500000201', 'manager', 'approved'),
    (v_coach1, 'series126_coach1', 'Series Test Coach One', '0500000202', 'coach', 'approved'),
    (v_coach2, 'series126_coach2', 'Series Test Coach Two', '0500000203', 'coach', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);

  -- A. Edit only coach for "this occurrence only": edited occurrence remains, original
  --    coach/template occurrence does not regenerate.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 401, '10:15', 6, 'ongoing', 'active') returning id into v_series_a;
  perform public._generate_series_occurrences(v_series_a, current_date + 401, current_date + 401);
  select id into v_sess_a from training_sessions where series_id = v_series_a and session_date = current_date + 401;

  select staff_update_session_series_scope(v_sess_a, 'this', current_date + 401, '10:15', v_coach2, 6, 60, false, false, false, null) into v_res;
  if not (v_res->>'ok')::boolean then raise exception 'A FAILED: update call rejected: %', v_res; end if;

  perform public._generate_series_occurrences(v_series_a, current_date + 401, current_date + 401);

  if not exists (select 1 from training_sessions where id = v_sess_a and coach_id = v_coach2 and series_detached = true) then
    raise exception 'A FAILED: edited occurrence missing/reverted';
  end if;
  if exists (select 1 from training_sessions where series_id = v_series_a and session_date = current_date + 401 and coach_id = v_coach1) then
    raise exception 'A FAILED: original-coach ghost regenerated';
  end if;
  if (select count(*) from training_sessions where series_id = v_series_a and session_date = current_date + 401) <> 1 then
    raise exception 'A FAILED: expected exactly 1 row for that date';
  end if;
  raise notice 'TEST A PASSED: coach-only this-occurrence edit does not regenerate the original coach ghost';

  -- B. Edit only start time: edited occurrence remains, original time does not regenerate.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 402, '11:00', 6, 'ongoing', 'active') returning id into v_series_b;
  perform public._generate_series_occurrences(v_series_b, current_date + 402, current_date + 402);
  select id into v_sess_b from training_sessions where series_id = v_series_b and session_date = current_date + 402;

  select staff_update_session_series_scope(v_sess_b, 'this', current_date + 402, '11:45', v_coach1, 6, 60, false, false, false, null) into v_res;
  if not (v_res->>'ok')::boolean then raise exception 'B FAILED: update call rejected: %', v_res; end if;

  perform public._generate_series_occurrences(v_series_b, current_date + 402, current_date + 402);

  if exists (select 1 from training_sessions where series_id = v_series_b and session_date = current_date + 402 and start_time = '11:00') then
    raise exception 'B FAILED: original-time ghost regenerated';
  end if;
  if (select count(*) from training_sessions where series_id = v_series_b and session_date = current_date + 402) <> 1 then
    raise exception 'B FAILED: expected exactly 1 row for that date';
  end if;
  raise notice 'TEST B PASSED: time-only this-occurrence edit does not regenerate the original-time ghost';

  -- C. Edit date: existing behavior remains correct.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 403, '12:00', 6, 'ongoing', 'active') returning id into v_series_c;
  perform public._generate_series_occurrences(v_series_c, current_date + 403, current_date + 403);
  select id into v_sess_c from training_sessions where series_id = v_series_c and session_date = current_date + 403;

  select staff_update_session_series_scope(v_sess_c, 'this', current_date + 404, '12:00', v_coach1, 6, 60, false, false, false, null) into v_res;
  if not (v_res->>'ok')::boolean then raise exception 'C FAILED: update call rejected: %', v_res; end if;

  perform public._generate_series_occurrences(v_series_c, current_date + 403, current_date + 404);

  if exists (select 1 from training_sessions where series_id = v_series_c and session_date = current_date + 403) then
    raise exception 'C FAILED: original date regenerated';
  end if;
  if not exists (select 1 from training_sessions where id = v_sess_c and session_date = current_date + 404) then
    raise exception 'C FAILED: moved occurrence missing at new date';
  end if;
  raise notice 'TEST C PASSED: date-move this-occurrence edit behaves as before';

  -- D. Delete one occurrence: it does not regenerate.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 405, '13:00', 6, 'ongoing', 'active') returning id into v_series_d;
  perform public._generate_series_occurrences(v_series_d, current_date + 405, current_date + 405);
  select id into v_sess_d from training_sessions where series_id = v_series_d and session_date = current_date + 405;

  select staff_delete_session_series_scope(v_sess_d, 'this') into v_res;
  if not (v_res->>'ok')::boolean then raise exception 'D FAILED: delete call rejected: %', v_res; end if;

  perform public._generate_series_occurrences(v_series_d, current_date + 405, current_date + 405);

  if exists (select 1 from training_sessions where series_id = v_series_d and session_date = current_date + 405) then
    raise exception 'D FAILED: deleted occurrence regenerated';
  end if;
  raise notice 'TEST D PASSED: deleted this-occurrence does not regenerate';

  -- E. Edit non-slot fields only: no unnecessary skip_dates entry, no duplication.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 406, '14:00', 6, 'ongoing', 'active') returning id into v_series_e;
  perform public._generate_series_occurrences(v_series_e, current_date + 406, current_date + 406);
  select id into v_sess_e from training_sessions where series_id = v_series_e and session_date = current_date + 406;

  select staff_update_session_series_scope(v_sess_e, 'this', current_date + 406, '14:00', v_coach1, 9, 60, false, false, false, null) into v_res;
  if not (v_res->>'ok')::boolean then raise exception 'E FAILED: update call rejected: %', v_res; end if;

  select skip_dates into v_skip from session_series where id = v_series_e;
  if (current_date + 406) = any(coalesce(v_skip, '{}'::date[])) then
    raise exception 'E FAILED: unnecessary skip_dates entry added for a non-slot-moving edit';
  end if;
  if not exists (select 1 from training_sessions where id = v_sess_e and max_participants = 9 and series_detached = true) then
    raise exception 'E FAILED: non-slot field edit did not apply / detach';
  end if;

  perform public._generate_series_occurrences(v_series_e, current_date + 406, current_date + 406);
  if (select count(*) from training_sessions where series_id = v_series_e and session_date = current_date + 406) <> 1 then
    raise exception 'E FAILED: expected exactly 1 row (no duplicate introduced)';
  end if;
  raise notice 'TEST E PASSED: non-slot-field edit leaves skip_dates untouched and does not duplicate';

  -- F. Run horizon maintenance multiple times: no duplicates.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 1, '15:30', 6, 'ongoing', 'active') returning id into v_series_f;

  perform public._maintain_session_series_horizon_core();
  perform public._maintain_session_series_horizon_core();
  perform public._maintain_session_series_horizon_core();

  if exists (
    select coach_id, session_date, start_time, count(*)
    from training_sessions
    where series_id = v_series_f
    group by coach_id, session_date, start_time
    having count(*) > 1
  ) then
    raise exception 'F FAILED: duplicate slots after repeated horizon maintenance';
  end if;
  raise notice 'TEST F PASSED: repeated horizon maintenance produced no duplicates';

  -- G. Simulate one series failing generation: other active series still generate.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 2, '16:00', 6, 'ongoing', 'active') returning id into v_series_g_ok;

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach2, current_date + 2, '17:00', 6, 'ongoing', 'active') returning id into v_series_g_bad;

  -- Pre-poison series_g_bad: a row at its exact next-generation date under a different
  -- (coach,time) slot -- the slot-exists check won't find it, so generation attempts a
  -- second (series_id, session_date) row and hits training_sessions_series_date_uidx.
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, series_id, series_detached)
  values (current_date + 2, '23:45', v_coach1, 6, v_series_g_bad, true)
  returning id into v_bad_occ;

  perform public._maintain_session_series_horizon_core();

  if not exists (select 1 from training_sessions where series_id = v_series_g_ok and session_date = current_date + 2) then
    raise exception 'G FAILED: healthy series did not generate while a sibling series failed';
  end if;
  if not exists (
    select 1 from user_activity_events
    where event_type = 'series_horizon_generation_failed'
      and target_id = v_series_g_bad::text
      and metadata->>'operation' = 'maintain_session_series_horizon'
  ) then
    raise exception 'G FAILED: failure for the broken series was not logged';
  end if;
  raise notice 'TEST G PASSED: broken series isolated + logged, healthy sibling series still generated';

  -- H (part 1 of 2, "already-correct rows remain unchanged"): a detached row that still
  -- exactly matches its template must not get a spurious skip_dates entry from the
  -- backfill predicate.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 407, '18:00', 6, 'ongoing', 'active') returning id into v_series_c;
  perform public._generate_series_occurrences(v_series_c, current_date + 407, current_date + 407);
  update training_sessions set series_detached = true where series_id = v_series_c and session_date = current_date + 407; -- matches template exactly

  with divergent as (
    select t.id as session_id, t.series_id, t.session_date
    from public.training_sessions t
    join public.session_series s on s.id = t.series_id
    where t.series_detached = true
      and t.session_date >= s.anchor_date
      and mod((t.session_date - s.anchor_date), 7) = 0
      and (t.start_time <> s.start_time or t.coach_id <> s.coach_id)
  )
  update public.session_series s
  set skip_dates = (
    select array_agg(distinct d order by d)
    from (
      select unnest(coalesce(s.skip_dates, '{}'::date[])) as d
      union all
      select d.session_date from divergent d where d.series_id = s.id
    ) u
  )
  where s.id in (select series_id from divergent);

  select skip_dates into v_skip from session_series where id = v_series_c;
  if (current_date + 407) = any(coalesce(v_skip, '{}'::date[])) then
    raise exception 'H FAILED: backfill touched an already-correct (non-divergent) row';
  end if;
  raise notice 'TEST H (part 1) PASSED: backfill predicate leaves an already-correct row unchanged';
end $$;

-- Separate block for the backfill invariant check (vulnerable row created directly,
-- bypassing the RPC, to simulate a pre-fix historical row).
do $$
declare
  v_coach1 uuid;
  v_series_h uuid;
  v_skip date[];
begin
  select user_id into v_coach1 from public.profiles where username = 'series126_coach1';

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, current_date + 409, '20:00', 6, 'ongoing', 'active') returning id into v_series_h;
  perform public._generate_series_occurrences(v_series_h, current_date + 409, current_date + 409);

  -- Simulate a pre-fix vulnerable row: divergent from template, no skip_dates entry.
  update training_sessions
  set series_detached = true, start_time = '20:30'
  where series_id = v_series_h and session_date = current_date + 409;

  select skip_dates into v_skip from session_series where id = v_series_h;
  if (current_date + 409) = any(coalesce(v_skip, '{}'::date[])) then
    raise exception 'H setup invalid: control date already protected';
  end if;

  -- Re-run the exact backfill predicate from the migration.
  with divergent as (
    select t.id as session_id, t.series_id, t.session_date
    from public.training_sessions t
    join public.session_series s on s.id = t.series_id
    where t.series_detached = true
      and t.session_date >= s.anchor_date
      and mod((t.session_date - s.anchor_date), 7) = 0
      and (t.start_time <> s.start_time or t.coach_id <> s.coach_id)
  )
  update public.session_series s
  set skip_dates = (
    select array_agg(distinct d order by d)
    from (
      select unnest(coalesce(s.skip_dates, '{}'::date[])) as d
      union all
      select d.session_date from divergent d where d.series_id = s.id
    ) u
  )
  where s.id in (select series_id from divergent);

  select skip_dates into v_skip from session_series where id = v_series_h;
  if not ((current_date + 409) = any(coalesce(v_skip, '{}'::date[]))) then
    raise exception 'H FAILED: backfill did not protect a simulated vulnerable historical row';
  end if;
  raise notice 'TEST H PASSED: backfill protects a simulated pre-fix vulnerable detached row';
end $$;

do $$ begin raise notice 'ALL SERIES SLOT-DRIFT / HORIZON HARDENING TESTS PASSED'; end $$;
