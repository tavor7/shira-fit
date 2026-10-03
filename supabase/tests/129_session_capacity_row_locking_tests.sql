-- Ordinary (single-connection, sequential) regression tests for the session-capacity row-locking
-- fix in 20261003120000_session_capacity_row_locking.sql. These prove the business-logic
-- contract (reject when full, accept when room, override still works, etc.) is unchanged by the
-- locking addition. They CANNOT and do not claim to prove the concurrency fix itself -- a
-- single-connection pgTAP `do $$ ... $$` block executes everything sequentially, so it cannot
-- exercise two transactions racing each other. See the migration's own report for why a true
-- multi-connection harness could not be run in this environment, and for the static/structural
-- proof of the locking fix instead.
set client_min_messages to notice;

do $$
declare
  v_coach uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_ath1 uuid := gen_random_uuid();
  v_ath2 uuid := gen_random_uuid();
  v_ath3 uuid := gen_random_uuid();
  v_manual1 uuid;
  v_sess_full uuid;
  v_sess_room uuid;
  v_sess_src uuid;
  v_sess_dst_full uuid;
  v_sess_dst_room uuid;
  v_res json;
  v_count int;
  v_sun date := current_date - extract(dow from current_date)::int + 50;
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status, gender) values
    (v_coach, 'cap_coach', 'Cap Coach', '9501', 'coach', 'approved', 'female'),
    (v_mgr, 'cap_mgr', 'Cap Manager', '9502', 'manager', 'approved', 'female'),
    (v_ath1, 'cap_ath1', 'Cap Athlete 1', '9503', 'athlete', 'approved', 'female'),
    (v_ath2, 'cap_ath2', 'Cap Athlete 2', '9504', 'athlete', 'approved', 'female'),
    (v_ath3, 'cap_ath3', 'Cap Athlete 3', '9505', 'athlete', 'approved', 'female');

  insert into public.manual_participants (full_name, phone) values ('Cap Manual 1', gen_random_uuid()::text)
    returning id into v_manual1;

  -- === T1: registration rejected when exactly full ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 1) returning id into v_sess_full;
  perform set_config('app.current_uid', v_ath1::text, true);
  v_res := public.register_for_session(v_sess_full);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T1 FIXTURE FAILED: first registration should succeed, got %', v_res; end if;

  perform set_config('app.current_uid', v_ath2::text, true);
  v_res := public.register_for_session(v_sess_full);
  if coalesce((v_res->>'ok')::boolean, false) or v_res->>'error' <> 'full' then
    raise exception 'T1 FAILED: expected full rejection, got %', v_res;
  end if;
  raise notice 'T1 PASSED: registration correctly rejected when session is exactly full';

  -- === T2: registration succeeds when capacity remains ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '11:00', v_coach, 2) returning id into v_sess_room;
  perform set_config('app.current_uid', v_ath1::text, true);
  v_res := public.register_for_session(v_sess_room);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T2 FAILED: expected success with room remaining, got %', v_res; end if;
  raise notice 'T2 PASSED: registration succeeds when capacity remains';

  -- === T3: cancellation frees the seat, a subsequent registration then succeeds ===
  perform set_config('app.current_uid', v_ath1::text, true);
  v_res := public.cancel_registration(v_sess_full, 'test cancel');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T3 FIXTURE FAILED: cancel should succeed, got %', v_res; end if;
  perform set_config('app.current_uid', v_ath2::text, true);
  v_res := public.register_for_session(v_sess_full);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T3 FAILED: expected success after cancellation freed the seat, got %', v_res; end if;
  raise notice 'T3 PASSED: cancellation frees capacity for the next registration';

  -- === T4: manager add respects capacity ===
  perform set_config('app.current_uid', v_mgr::text, true);
  v_res := public.coach_add_athlete(v_sess_full, v_ath3);
  if coalesce((v_res->>'ok')::boolean, false) or v_res->>'error' <> 'full' then
    raise exception 'T4 FAILED: expected full rejection from coach_add_athlete, got %', v_res;
  end if;
  raise notice 'T4 PASSED: coach_add_athlete respects capacity';

  -- === T5: manual participant respects capacity ===
  perform set_config('app.current_uid', v_mgr::text, true);
  v_res := public.add_manual_participant_to_session(v_sess_full, v_manual1);
  if coalesce((v_res->>'ok')::boolean, false) or v_res->>'error' <> 'full' then
    raise exception 'T5 FAILED: expected full rejection from add_manual_participant_to_session, got %', v_res;
  end if;
  raise notice 'T5 PASSED: add_manual_participant_to_session respects capacity';

  -- === T6: explicit authorized override still succeeds (series-roster-copy style call) ===
  v_res := public.coach_add_athlete(v_sess_full, v_ath3, true);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T6 FAILED: p_allow_over_capacity=true should still bypass the capacity rejection, got %', v_res;
  end if;
  select public.active_registration_count(v_sess_full) into v_count;
  if v_count <= 1 then raise exception 'T6 FAILED: expected the override to actually have added an occupant, count=%', v_count; end if;
  raise notice 'T6 PASSED: explicit p_allow_over_capacity=true override still succeeds and the lock does not block it';

  -- === T7: move into a full destination session rejects ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 2, '09:00', v_coach, 2) returning id into v_sess_src;
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 2, '10:00', v_coach, 1) returning id into v_sess_dst_full;
  perform set_config('app.current_uid', v_ath1::text, true);
  v_res := public.register_for_session(v_sess_src);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T7 FIXTURE FAILED: source registration should succeed, got %', v_res; end if;
  perform set_config('app.current_uid', v_ath2::text, true);
  v_res := public.register_for_session(v_sess_dst_full);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T7 FIXTURE FAILED: destination filler should succeed, got %', v_res; end if;

  perform set_config('app.current_uid', v_mgr::text, true);
  v_res := public.staff_move_session_participant(v_sess_src, v_sess_dst_full, v_ath1, null);
  if coalesce((v_res->>'ok')::boolean, false) or v_res->>'error' <> 'full' then
    raise exception 'T7 FAILED: expected full rejection moving into a full destination, got %', v_res;
  end if;
  -- Source must be unaffected by a rejected move.
  if not exists (select 1 from session_registrations where session_id = v_sess_src and user_id = v_ath1 and status = 'active') then
    raise exception 'T7 FAILED: a rejected move must leave the source registration untouched';
  end if;
  raise notice 'T7 PASSED: move into a full destination session is rejected and the source is left untouched';

  -- === T8: move into a destination with exactly one remaining seat succeeds ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 3, '10:00', v_coach, 2) returning id into v_sess_dst_room;
  perform set_config('app.current_uid', v_ath3::text, true);
  v_res := public.register_for_session(v_sess_dst_room);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T8 FIXTURE FAILED: destination filler should succeed, got %', v_res; end if;

  perform set_config('app.current_uid', v_mgr::text, true);
  v_res := public.staff_move_session_participant(v_sess_src, v_sess_dst_room, v_ath1, null);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T8 FAILED: expected success moving into a destination with exactly one open seat, got %', v_res;
  end if;
  select public.active_registration_count(v_sess_dst_room) into v_count;
  if v_count <> 2 then raise exception 'T8 FAILED: expected destination occupancy 2, got %', v_count; end if;
  raise notice 'T8 PASSED: move into a destination with exactly one remaining seat succeeds';

  -- === T9: retry/idempotency -- re-registering an already-active registration is rejected, not
  --        duplicated. Uses v_sess_room (capacity 2, only v_ath1 active) rather than
  --        v_sess_dst_full (capacity 1, already full) specifically so the capacity check -- which
  --        runs BEFORE the already_registered self-check in register_for_session, confirmed
  --        pre-existing production behavior unrelated to this migration -- doesn't shadow the
  --        already_registered result with 'full' instead. ===
  perform set_config('app.current_uid', v_ath1::text, true);
  v_res := public.register_for_session(v_sess_room);
  if coalesce((v_res->>'ok')::boolean, false) or v_res->>'error' <> 'already_registered' then
    raise exception 'T9 FAILED: expected already_registered on a retried registration, got %', v_res;
  end if;
  select count(*) into v_count from session_registrations where session_id = v_sess_room and user_id = v_ath1 and status = 'active';
  if v_count <> 1 then raise exception 'T9 FAILED: expected exactly 1 active row despite the retry, got %', v_count; end if;
  raise notice 'T9 PASSED: retrying an already-active registration is rejected, not duplicated';

  raise notice 'ALL SESSION CAPACITY ROW-LOCKING ORDINARY TESTS (T1-T9) PASSED';
end $$;

-- === T10: direct-insert bypass is closed -- session_manual_participants_insert_staff no longer
--           exists, matching session_registrations/waitlist_requests having zero INSERT policy.
--
-- Note: this is a structural check (the policy is gone from pg_catalog), not a live
-- role-simulated INSERT-denial test. Actually proving RLS denies a real `authenticated`-role
-- client requires running as that Postgres role (via SET ROLE / a non-superuser test
-- connection), not just mocking auth.uid() via the app.current_uid GUC this suite's tests use
-- elsewhere for the SECURITY DEFINER RPCs -- pgTAP here runs as the table owner, which bypasses
-- RLS regardless of policy presence, so a live INSERT would not actually exercise the policy.
-- The structural check below is what's reliably provable in this harness.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'session_manual_participants'
    and policyname = 'session_manual_participants_insert_staff';
  if v_count <> 0 then
    raise exception 'T10 FAILED: session_manual_participants_insert_staff should have been dropped, found % row(s)', v_count;
  end if;

  -- The other three policies (select/update/delete) must remain untouched -- only INSERT closed.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'session_manual_participants'
    and policyname in (
      'session_manual_participants_select_staff',
      'session_manual_participants_update_staff',
      'session_manual_participants_delete_manager'
    );
  if v_count <> 3 then
    raise exception 'T10 FAILED: expected the 3 non-insert policies to remain untouched, found %', v_count;
  end if;
  raise notice 'T10 PASSED: session_manual_participants_insert_staff is dropped; select/update/delete policies untouched';
end $$;
