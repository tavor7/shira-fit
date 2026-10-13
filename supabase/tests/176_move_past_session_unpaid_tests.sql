-- Tests for 20261017100000_move_past_session_participant_unpaid.sql: staff_move_session_participant
-- may now move a participant OUT of an already-started (past) source session, but only when no
-- payment has been recorded for their participation in it.
--
-- Harness: plain scripted-assertion SQL (DO blocks, RAISE EXCEPTION on failure), same convention
-- as supabase/tests/30_move_bypass_tests.sql. Run against a scratch postgres:15 container with:
--   1. 00_stub_schema.sql
--   2. 01_move_stub_schema.sql
--   3. ../migrations/20260924100000_subscriptions_schema.sql
--   4. ../migrations/20260924110000_subscriptions_atomic_registration.sql
--   5. ../migrations/20260924120000_subscriptions_close_registration_bypasses.sql
--   6. ../migrations/20260925120112_drop_pre_subscription_rpc_overloads.sql
--   7. ../migrations/20261003120000_session_capacity_row_locking.sql
--   8. A minimal stand-in for public._payment_has_active_document (the real receipts/documents
--      subsystem is out of scope here and has its own coverage, e.g.
--      supabase/tests/164_receipted_session_payment_lock_tests.sh) -- see
--      the `_test_receipts` table / function defined inline below for the exact shape used.
--   9. ../migrations/20261017100000_move_past_session_participant_unpaid.sql
--  10. This file.
-- All of the above was actually executed in a scratch postgres:15 Docker container during
-- development of this migration; every DO block below passed.
set client_min_messages to notice;

-- Stand-in for the real receipts/documents subsystem's "has an active receipt" signal (see header).
create table if not exists public._test_receipts (
  row_kind text not null,
  record_id uuid not null,
  primary key (row_kind, record_id)
);
create or replace function public._payment_has_active_document(p_row_kind text, p_record_id uuid)
returns boolean language sql stable as $$
  select exists(select 1 from public._test_receipts where row_kind = p_row_kind and record_id = p_record_id);
$$;

-- Fixtures: manager, two coaches (C owns the test sessions, C2 does not), athletes, a manual
-- participant. Sessions use time-of-day (not calendar date) to control started/not-started
-- deterministically and keep source+destination trivially in the same studio week:
--   PAST session: today at 00:00:01 (long since started by the time this runs)
--   FUTURE session: today at 23:59:00 (not started yet)
do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_coach2 uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_other_athlete uuid := gen_random_uuid();
  v_mp uuid;
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_manager, 'mv_mgr', 'Move Manager', '0510000001', 'manager', 'approved'),
    (v_coach, 'mv_coach', 'Move Coach', '0510000002', 'coach', 'approved'),
    (v_coach2, 'mv_coach2', 'Move Coach Two', '0510000003', 'coach', 'approved'),
    (v_athlete, 'mv_athlete', 'Move Athlete', '0510000004', 'athlete', 'approved'),
    (v_other_athlete, 'mv_other', 'Move Other Athlete', '0510000005', 'athlete', 'approved');

  insert into public.manual_participants (full_name, phone) values ('Move Manual Person', '0510000006')
  returning id into v_mp;

  create table if not exists _mvids (k text primary key, v uuid);
  insert into _mvids values
    ('manager', v_manager), ('coach', v_coach), ('coach2', v_coach2),
    ('athlete', v_athlete), ('other_athlete', v_other_athlete), ('mp', v_mp);
end $$;

-- T1 (baseline, must be byte-for-byte unchanged): FUTURE session, unpaid athlete -> move succeeds.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  select v into v_athlete from _mvids where k='athlete';
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:58:00', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T1 FAILED: future unpaid move rejected: %', v_res;
  end if;
  if exists (select 1 from session_registrations where session_id=v_src and user_id=v_athlete and status='active') then
    raise exception 'T1 FAILED: source still active';
  end if;
  if not exists (select 1 from session_registrations where session_id=v_dst and user_id=v_athlete and status='active') then
    raise exception 'T1 FAILED: destination not active';
  end if;
  raise notice 'T1 PASSED: future-session unpaid move unchanged';
end $$;

-- T2: FUTURE session, roster_locked (attendance already marked) -> still blocked exactly as before.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t2', 'T2 Athlete', '0510000010', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:57:00', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended)
  values (v_src, v_athlete, 'active', true);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'roster_locked' then
    raise exception 'T2 FAILED: expected roster_locked for a not-yet-started session with attendance set, got %', v_res;
  end if;
  raise notice 'T2 PASSED: future-session roster_locked unchanged (attendance alone still blocks pre-start)';
end $$;

-- T3: PAST session, fully unpaid (attended null, no payment) -> ALLOWED.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t3', 'T3 Athlete', '0510000011', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T3 FAILED: past unpaid move rejected: %', v_res;
  end if;
  raise notice 'T3 PASSED: past-session unpaid move allowed';
end $$;

-- T4: PAST session, outstanding balance but $0 paid (attended=true, no payment_method/amount) ->
-- ALLOWED (an unpaid "arrived" row is not a recorded payment).
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t4', 'T4 Athlete', '0510000012', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended)
  values (v_src, v_athlete, 'active', true);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T4 FAILED: past session with $0 paid (arrived, no payment) should be allowed, got %', v_res;
  end if;
  raise notice 'T4 PASSED: past session, outstanding balance / $0 paid -> allowed';
end $$;

-- T4b: PAST session, absent + charge_no_show flagged but $0 actually collected -> ALLOWED.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t4b', 'T4b Athlete', '0510000013', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended, charge_no_show)
  values (v_src, v_athlete, 'active', false, true);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T4b FAILED: past session, no-show charge flagged but uncollected, should be allowed, got %', v_res;
  end if;
  raise notice 'T4b PASSED: past session, no-show charge flagged / $0 collected -> allowed';
end $$;

-- T5: PAST session, FULLY paid (amount_paid > 0) -> BLOCKED (payment_recorded), untouched.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t5', 'T5 Athlete', '0510000014', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid)
  values (v_src, v_athlete, 'active', true, 'cash', 120);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'payment_recorded' then
    raise exception 'T5 FAILED: fully-paid past session should be blocked with payment_recorded, got %', v_res;
  end if;
  if not exists (select 1 from session_registrations where session_id=v_src and user_id=v_athlete and status='active' and amount_paid=120) then
    raise exception 'T5 FAILED: source registration was touched despite rejection';
  end if;
  raise notice 'T5 PASSED: fully-paid past session blocked, untouched';
end $$;

-- T6: PAST session, PARTIALLY paid (amount_paid > 0 but less than full price) -> BLOCKED.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t6', 'T6 Athlete', '0510000015', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid)
  values (v_src, v_athlete, 'active', true, 'bit', 20);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'payment_recorded' then
    raise exception 'T6 FAILED: partially-paid past session should be blocked with payment_recorded, got %', v_res;
  end if;
  raise notice 'T6 PASSED: partially-paid past session blocked';
end $$;

-- T7: PAST session, manual participant with a recorded payment -> BLOCKED.
do $$
declare v_coach uuid; v_mp uuid; v_src uuid; v_dst uuid; v_res json; v_smp uuid;
begin
  select v into v_coach from _mvids where k='coach';
  insert into public.manual_participants (full_name, phone) values ('T7 Manual', '0510000016') returning id into v_mp;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_manual_participants (session_id, manual_participant_id, attended, payment_method, amount_paid)
  values (v_src, v_mp, true, 'cash', 120) returning id into v_smp;

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, null, v_mp);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'payment_recorded' then
    raise exception 'T7 FAILED: manual participant with a recorded payment should be blocked, got %', v_res;
  end if;
  if not exists (select 1 from session_manual_participants where id=v_smp and session_id=v_src and amount_paid=120) then
    raise exception 'T7 FAILED: manual participant row was touched despite rejection';
  end if;
  raise notice 'T7 PASSED: manual participant with a recorded payment blocked, untouched';
end $$;

-- T8: PAST session, amount_paid = 0 (not null) but a receipt/document already exists for it ->
-- BLOCKED (the _payment_has_active_document fallback catches it even though amount_paid itself
-- is not positive -- e.g. a manager cleared the amount after a receipt had already been issued).
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json; v_reg uuid;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t8', 'T8 Athlete', '0510000017', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status, attended, amount_paid)
  values (v_src, v_athlete, 'active', true, 0) returning id into v_reg;
  insert into public._test_receipts (row_kind, record_id) values ('session_reg', v_reg);

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'payment_recorded' then
    raise exception 'T8 FAILED: a row with an active receipt but amount_paid=0 should still be blocked, got %', v_res;
  end if;
  raise notice 'T8 PASSED: active-receipt fallback blocks the move even when amount_paid itself is 0';
end $$;

-- T9: destination already started -> still blocked (session_started), regardless of source payment.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t9', 'T9 Athlete', '0510000018', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:02', v_coach, 6) returning id into v_dst; -- also already started
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'session_started' then
    raise exception 'T9 FAILED: a started destination should still be rejected, got %', v_res;
  end if;
  raise notice 'T9 PASSED: started destination still rejected (session_started)';
end $$;

-- T10: destination at capacity -> blocked (full), without allow_over_capacity.
do $$
declare v_coach uuid; v_athlete uuid; v_filler uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid(); v_filler := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_athlete, 'mv_t10', 'T10 Athlete', '0510000019', 'athlete', 'approved'),
    (v_filler, 'mv_t10f', 'T10 Filler', '0510000020', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 1) returning id into v_dst; -- cap 1, already full
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');
  insert into public.session_registrations (session_id, user_id, status) values (v_dst, v_filler, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'full' then
    raise exception 'T10 FAILED: full destination should be rejected, got %', v_res;
  end if;
  raise notice 'T10 PASSED: full destination rejected for a past unpaid source';
end $$;

-- T11: duplicate destination registration -> blocked (already_in_session).
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t11', 'T11 Athlete', '0510000021', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');
  insert into public.session_registrations (session_id, user_id, status) values (v_dst, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'already_in_session' then
    raise exception 'T11 FAILED: duplicate destination registration should be rejected, got %', v_res;
  end if;
  raise notice 'T11 PASSED: duplicate destination registration rejected';
end $$;

-- T12: unauthorized direct RPC call -- a coach who does not own the source session is forbidden
-- (proves the restriction is enforced in the RPC itself, not only by hiding the UI button).
do $$
declare v_coach uuid; v_coach2 uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  select v into v_coach2 from _mvids where k='coach2';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t12', 'T12 Athlete', '0510000022', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach2::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'forbidden' then
    raise exception 'T12 FAILED: a coach who does not own the session should be forbidden, got %', v_res;
  end if;
  if not exists (select 1 from session_registrations where session_id=v_src and user_id=v_athlete and status='active') then
    raise exception 'T12 FAILED: source was touched despite forbidden caller';
  end if;
  raise notice 'T12 PASSED: unauthorized coach forbidden, source untouched (RPC-level enforcement, not just UI)';

  -- Also: a paid participant cannot be moved by calling the RPC directly either (manager this time).
  update session_registrations set attended = true, payment_method = 'cash', amount_paid = 100
  where session_id = v_src and user_id = v_athlete;
  perform set_config('app.current_uid', (select v from _mvids where k='manager')::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'payment_recorded' then
    raise exception 'T12b FAILED: a manager calling the RPC directly should still be blocked for a paid participant, got %', v_res;
  end if;
  raise notice 'T12b PASSED: direct RPC call cannot bypass the payment-recorded block, even for a manager';
end $$;

-- T13: idempotency / double-submit -- the second call for the same already-moved participant
-- must fail cleanly (not_on_source), not silently double-move or error out uncontrolled.
do $$
declare v_coach uuid; v_athlete uuid; v_src uuid; v_dst uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  v_athlete := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'mv_t13', 'T13 Athlete', '0510000023', 'athlete', 'approved');
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 6) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 6) returning id into v_dst;
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_athlete, 'active');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T13 FAILED: first move should succeed, got %', v_res;
  end if;
  v_res := public.staff_move_session_participant(v_src, v_dst, v_athlete, null);
  if (v_res->>'ok')::boolean is true or v_res->>'error' <> 'not_on_source' then
    raise exception 'T13 FAILED: double-submit should fail cleanly with not_on_source, got %', v_res;
  end if;
  if (select count(*) from session_registrations where session_id=v_dst and user_id=v_athlete and status='active') <> 1 then
    raise exception 'T13 FAILED: double-submit produced more than one active destination registration';
  end if;
  raise notice 'T13 PASSED: double-submit is idempotent (second call refused, no duplicate registration)';
end $$;

-- T14: subscription participant, PAST unpaid source, covered destination -> succeeds exactly like
-- a future-session subscription move (subscription gate / coverage bookkeeping untouched).
do $$
declare
  v_coach uuid; v_e uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_src uuid; v_dst uuid; v_res json; v_reg uuid;
begin
  select v into v_coach from _mvids where k='coach';
  v_e := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_e, 'mv_t14', 'T14 Subscriber', '0510000024', 'athlete', 'approved');

  v_week_sun := current_date - extract(dow from current_date)::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_e, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 30, 300, 1, v_week_sun - 30) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 2);

  -- Source: already-started, same tier (3-cap), unpaid, attended -- covered by the subscription.
  -- Built directly (not via register_for_session, which itself refuses to register into a
  -- session that has already ENDED, a separate self-registration rule out of scope here) to
  -- simulate "this was a normal covered registration, and the session has since happened".
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 3) returning id into v_src;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 3) returning id into v_dst;

  insert into public.session_registrations (session_id, user_id, status, attended)
  values (v_src, v_e, 'active', true)
  returning id into v_reg;
  insert into public.subscription_registration_coverage (
    subscription_id, version_id, registration_id, session_date, week_start, tier, covered, decided_by
  ) values (v_sub, v_ver, v_reg, current_date, v_week_sun, 'trio', true, 'registration');

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_e, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'T14 FAILED: past unpaid subscription move rejected: %', v_res;
  end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id
       where r.session_id=v_dst and r.user_id=v_e) is not true then
    raise exception 'T14 FAILED: destination should be covered=true';
  end if;
  raise notice 'T14 PASSED: subscription participant, past unpaid source, moved and covered correctly';
end $$;

-- T15: manual participant, PAST session, attended + no-show-flagged but unpaid, destination
-- REJECTED by the subscription gate -> compensate path must restore the source exactly as it
-- was, INCLUDING attended/charge_no_show (regression check for the fix in this migration: the
-- compensate-insert previously dropped these columns, which was harmless only while roster_locked
-- guaranteed they were always null/false -- no longer true now that a past, attended-but-unpaid
-- manual participant can reach this path).
do $$
declare
  v_coach uuid; v_mp uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_anchor uuid; v_src uuid; v_dst_full uuid; v_res json;
begin
  select v into v_coach from _mvids where k='coach';
  insert into public.manual_participants (full_name, phone) values ('T15 Manual', '0510000025') returning id into v_mp;

  v_week_sun := current_date - extract(dow from current_date)::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_mp, true) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'quartet', 1);

  -- Anchor: a different, NOT-moved quartet registration that consumes the week's only allowance
  -- slot, so the destination below is genuinely over-allowance (not just "the pool freed by
  -- releasing the source itself").
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:03', v_coach, 4) returning id into v_anchor;
  perform public._series_add_manual_participant_checked(v_anchor, v_mp);
  if (select cov.covered from subscription_registration_coverage cov where cov.manual_participant_id =
        (select id from session_manual_participants where session_id=v_anchor and manual_participant_id=v_mp)
     ) is not true then
    raise exception 'T15 setup FAILED: anchor not covered';
  end if;

  -- Source: already-started quartet session, attended + no-show-charge flagged, unpaid (allowed to move).
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '00:00:01', v_coach, 4) returning id into v_src;
  insert into public.session_manual_participants (session_id, manual_participant_id, attended, charge_no_show)
  values (v_src, v_mp, false, true);

  -- Destination: another quartet session, same week, not started -- but allowance is exhausted
  -- by the anchor, so without consent this must be rejected.
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date, '23:59:00', v_coach, 4) returning id into v_dst_full;

  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst_full, null, v_mp);
  if (v_res->>'ok')::boolean is true then
    raise exception 'T15 FAILED: destination should have been rejected (allowance_exceeded), got %', v_res;
  end if;
  if v_res->>'error' <> 'subscription_limit_exceeded' then
    raise exception 'T15 FAILED: expected subscription_limit_exceeded, got %', v_res;
  end if;

  if not exists (
    select 1 from session_manual_participants
    where session_id = v_src and manual_participant_id = v_mp
      and attended is false and charge_no_show is true
      and amount_paid is null and payment_method is null
  ) then
    raise exception 'T15 FAILED: compensate-restore lost attended/charge_no_show on the source row -- historical data corrupted';
  end if;
  raise notice 'T15 PASSED: rejected move compensate-restores the manual participant with attended/charge_no_show intact';
end $$;

do $$ begin raise notice 'ALL MOVE-PAST-SESSION-UNPAID TESTS PASSED'; end $$;
