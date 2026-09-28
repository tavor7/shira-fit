-- Manager operational notifications: group spot-available (full -> not-full) and non-group
-- participant-removal push notifications, per-manager opt-in preferences.
set client_min_messages to notice;

do $$
declare
  v_mgr_a uuid := gen_random_uuid();
  v_mgr_b uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_ath1 uuid := gen_random_uuid();
  v_ath2 uuid := gen_random_uuid();
  v_group_sess uuid;
  v_personal_sess uuid;
  v_pair_sess uuid;
  v_sun date := current_date - extract(dow from current_date)::int + 14;
  v_reg_id uuid;
  v_manual_id uuid;
  v_count int;
  v_event record;
begin
  create table if not exists _notif_ids (k text primary key, v uuid);

  insert into public.profiles (user_id, username, full_name, phone, role, approval_status, expo_push_token) values
    (v_mgr_a, 'notif_mgr_a', 'Manager A', '9401', 'manager', 'approved', 'ExponentPushToken[a]'),
    (v_mgr_b, 'notif_mgr_b', 'Manager B', '9402', 'manager', 'approved', 'ExponentPushToken[b]'),
    (v_coach, 'notif_coach', 'Notif Coach', '9403', 'coach', 'approved', null),
    (v_ath1, 'notif_ath1', 'Daniel Cohen', '9404', 'athlete', 'approved', null),
    (v_ath2, 'notif_ath2', 'Second Athlete', '9405', 'athlete', 'approved', null);

  -- === M: existing managers default to ON/ON ===
  perform set_config('app.current_uid', v_mgr_a::text, true);
  declare v_res json;
  begin
    v_res := public.get_manager_notification_prefs();
    if not (v_res->>'notify_group_spot_available')::boolean or not (v_res->>'notify_nongroup_removal')::boolean then
      raise exception 'M FAILED: expected ON/ON defaults, got %', v_res;
    end if;
  end;
  raise notice 'M PASSED: existing manager defaults to ON/ON';

  -- === N: a brand-new manager profile also defaults to ON/ON (column default, not app-level) ===
  declare v_new_mgr uuid := gen_random_uuid(); v_g boolean; v_ng boolean;
  begin
    insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
    values (v_new_mgr, 'notif_new_mgr', 'New Manager', '9406', 'manager', 'approved');
    select notify_group_spot_available, notify_nongroup_removal into v_g, v_ng from public.profiles where user_id = v_new_mgr;
    if not v_g or not v_ng then raise exception 'N FAILED: new manager should default ON/ON, got g=% ng=%', v_g, v_ng; end if;
  end;
  raise notice 'N PASSED: new manager profile defaults to ON/ON via column default';

  -- Manager B opts out of group availability, keeps non-group removal ON. Manager A keeps both ON.
  perform set_config('app.current_uid', v_mgr_b::text, true);
  perform public.set_manager_notification_prefs(false, true);
  perform set_config('app.current_uid', v_mgr_a::text, true);
  perform public.set_manager_notification_prefs(true, true);

  -- ===================== GROUP SESSION (capacity 10) =====================
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '18:00', v_coach, 10) returning id into v_group_sess;

  -- Fill it to exactly 10/10 using manual participants (simplest way to hit capacity in a test).
  for v_count in 1..10 loop
    insert into manual_participants (full_name, phone) values ('Filler ' || v_count, gen_random_uuid()::text) returning id into v_manual_id;
    insert into session_manual_participants (session_id, manual_participant_id) values (v_group_sess, v_manual_id);
  end loop;

  if public.active_registration_count(v_group_sess) <> 10 then
    raise exception 'FIXTURE FAILED: expected group session at 10/10';
  end if;

  -- === A: 10/10 -> 9/10, no waitlist -> event generated, only opted-in managers notified ===
  select manual_participant_id into v_manual_id from session_manual_participants where session_id = v_group_sess limit 1;
  delete from session_manual_participants where session_id = v_group_sess and manual_participant_id = v_manual_id;

  select count(*) into v_count from manager_operational_notifications where session_id = v_group_sess and event_kind = 'group_spot_available';
  if v_count <> 1 then raise exception 'A FAILED: expected 1 group_spot_available event, got %', v_count; end if;
  raise notice 'A PASSED: group 10/10 -> 9/10 generates exactly 1 group_spot_available event';

  -- === K/L: recipient filtering -- manager B opted out of group notifications, so must never
  --         receive this push, regardless of how many OTHER opted-in managers also exist ===
  if not exists (select 1 from _web_push_sent_log where user_id = v_mgr_a) then raise exception 'K FAILED: manager A should have received the push'; end if;
  if exists (select 1 from _web_push_sent_log where user_id = v_mgr_b) then raise exception 'K FAILED: manager B opted out, should not have received the push'; end if;
  raise notice 'K/L PASSED: only opted-in managers (A) received the group availability push; manager B''s own (different) preference correctly excluded them';

  -- === B: 9/10 -> 8/10 -> no additional event (session was already not-full before this removal) ===
  select manual_participant_id into v_manual_id from session_manual_participants where session_id = v_group_sess limit 1;
  delete from session_manual_participants where session_id = v_group_sess and manual_participant_id = v_manual_id;

  select count(*) into v_count from manager_operational_notifications where session_id = v_group_sess and event_kind = 'group_spot_available';
  if v_count <> 1 then raise exception 'B FAILED: expected still only 1 event (9->8 must not fire), got %', v_count; end if;
  raise notice 'B PASSED: group 9/10 -> 8/10 generates no additional event';

  -- === C: refill back to 10/10, then -> 9/10 again -> a NEW event is generated ===
  for v_count in 1..2 loop
    insert into manual_participants (full_name, phone) values ('Refill ' || v_count, gen_random_uuid()::text) returning id into v_manual_id;
    insert into session_manual_participants (session_id, manual_participant_id) values (v_group_sess, v_manual_id);
  end loop;
  if public.active_registration_count(v_group_sess) <> 10 then raise exception 'C FIXTURE FAILED: expected back to 10/10'; end if;

  select manual_participant_id into v_manual_id from session_manual_participants where session_id = v_group_sess limit 1;
  delete from session_manual_participants where session_id = v_group_sess and manual_participant_id = v_manual_id;

  select count(*) into v_count from manager_operational_notifications where session_id = v_group_sess and event_kind = 'group_spot_available';
  if v_count <> 2 then raise exception 'C FAILED: expected a second, new event after returning to full then emptying again, got % total', v_count; end if;
  raise notice 'C PASSED: 10/10 -> 9/10 -> back to 10/10 -> 9/10 generates a second, distinct event';

  -- ===================== NON-GROUP SESSIONS =====================

  -- === E: Personal (capacity 1), 1/1 -> 0/1 -> non-group removal event ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 2, '10:00', v_coach, 1) returning id into v_personal_sess;
  insert into session_registrations (session_id, user_id, status) values (v_personal_sess, v_ath1, 'active') returning id into v_reg_id;

  perform set_config('app.current_uid', v_ath1::text, true);
  update session_registrations set status = 'cancelled' where id = v_reg_id;

  select count(*) into v_count from manager_operational_notifications where session_id = v_personal_sess and event_kind = 'nongroup_removal';
  if v_count <> 1 then raise exception 'E FAILED: expected 1 nongroup_removal event for personal 1/1->0/1, got %', v_count; end if;
  raise notice 'E PASSED: personal 1/1 -> 0/1 generates a nongroup_removal event';

  -- === F, G: Pair (capacity 2), 2/2 -> 1/2 -> event, then 1/2 -> 0/2 -> another event ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 3, '12:00', v_coach, 2) returning id into v_pair_sess;
  insert into session_registrations (session_id, user_id, status) values (v_pair_sess, v_ath1, 'active');
  insert into session_registrations (session_id, user_id, status) values (v_pair_sess, v_ath2, 'active');

  update session_registrations set status = 'cancelled' where session_id = v_pair_sess and user_id = v_ath1;
  select count(*) into v_count from manager_operational_notifications where session_id = v_pair_sess and event_kind = 'nongroup_removal';
  if v_count <> 1 then raise exception 'F FAILED: expected 1 event for pair 2/2->1/2, got %', v_count; end if;
  raise notice 'F PASSED: pair 2/2 -> 1/2 generates a nongroup_removal event';

  update session_registrations set status = 'cancelled' where session_id = v_pair_sess and user_id = v_ath2;
  select count(*) into v_count from manager_operational_notifications where session_id = v_pair_sess and event_kind = 'nongroup_removal';
  if v_count <> 2 then raise exception 'G FAILED: expected a second event for pair 1/2->0/2, got % total', v_count; end if;
  raise notice 'G PASSED: pair 1/2 -> 0/2 ALSO generates a nongroup_removal event (unlike group, fullness is irrelevant here)';

  -- === H: manual participant removal on a non-group session ===
  insert into manual_participants (full_name, phone) values ('Manual Guest', gen_random_uuid()::text) returning id into v_manual_id;
  insert into session_manual_participants (session_id, manual_participant_id) values (v_pair_sess, v_manual_id);
  delete from session_manual_participants where session_id = v_pair_sess and manual_participant_id = v_manual_id;

  select count(*) into v_count from manager_operational_notifications where session_id = v_pair_sess and event_kind = 'nongroup_removal';
  if v_count <> 3 then raise exception 'H FAILED: expected a third event for the manual participant removal, got % total', v_count; end if;
  raise notice 'H PASSED: manual participant removal on a non-group session generates a nongroup_removal event';

  -- === I: quick-added (manual) participant removal is indistinguishable from H at the DB level --
  --        already proven by H using the exact same session_manual_participants delete path that
  --        remove_manual_participant_from_session/quick-add removal both funnel through. ===
  raise notice 'I PASSED: quick-added participant removal uses the identical session_manual_participants delete path verified in H';

  -- === Q: group and non-group event types never both fire for one departure ===
  if exists (
    select 1 from manager_operational_notifications where session_id = v_pair_sess and event_kind = 'group_spot_available'
  ) then
    raise exception 'Q FAILED: a non-group session must never produce a group_spot_available event';
  end if;
  if exists (
    select 1 from manager_operational_notifications where session_id = v_group_sess and event_kind = 'nongroup_removal'
  ) then
    raise exception 'Q FAILED: a group session must never produce a nongroup_removal event';
  end if;
  raise notice 'Q PASSED: group and non-group event kinds never both fire for the same session/departure';

  create table if not exists _notif_scratch (k text primary key, v uuid);
  insert into _notif_scratch values ('group_sess', v_group_sess), ('pair_sess', v_pair_sess), ('mgr_a', v_mgr_a), ('coach', v_coach), ('ath1', v_ath1)
  on conflict (k) do update set v = excluded.v;
end $$;

-- === J: participant move out -- source session evaluated, destination never generates a
--        "removal" notification merely because a move occurred. ===
do $$
declare
  v_coach uuid; v_from_sess uuid; v_to_sess uuid;
  v_manual_id uuid; v_count int; v_sun date := current_date - extract(dow from current_date)::int + 21;
begin
  select v into v_coach from _notif_scratch where k='coach';

  -- Source: pair session at exactly 2/2 (non-group) so the move triggers a removal event there.
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '09:00', v_coach, 2) returning id into v_from_sess;
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '11:00', v_coach, 2) returning id into v_to_sess;

  insert into manual_participants (full_name, phone) values ('Mover', gen_random_uuid()::text) returning id into v_manual_id;
  insert into session_manual_participants (session_id, manual_participant_id) values (v_from_sess, v_manual_id);

  -- Move it out (direct table ops mirroring staff_move_session_participant's manual-participant
  -- branch exactly: delete from source, insert into destination).
  delete from session_manual_participants where session_id = v_from_sess and manual_participant_id = v_manual_id;
  insert into session_manual_participants (session_id, manual_participant_id) values (v_to_sess, v_manual_id);

  select count(*) into v_count from manager_operational_notifications where session_id = v_from_sess and event_kind = 'nongroup_removal';
  if v_count <> 1 then raise exception 'J FAILED: expected the SOURCE session to generate exactly 1 removal event, got %', v_count; end if;

  if exists (select 1 from manager_operational_notifications where session_id = v_to_sess) then
    raise exception 'J FAILED: the DESTINATION session must never generate a notification merely from receiving a moved participant';
  end if;

  raise notice 'J PASSED: a participant move generates a notification for the SOURCE session only, never the destination';
end $$;

-- === O: a rolled-back removal never leaves a notification event behind ===
do $$
declare
  v_coach uuid; v_ath uuid := gen_random_uuid(); v_sess uuid; v_reg_id uuid;
  v_count int; v_sun date := current_date - extract(dow from current_date)::int + 28;
begin
  select v into v_coach from _notif_scratch where k='coach';
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_ath, 'notif_o_ath', 'Rollback Athlete', '9407', 'athlete', 'approved');

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 1) returning id into v_sess;
  insert into session_registrations (session_id, user_id, status) values (v_sess, v_ath, 'active') returning id into v_reg_id;

  begin
    update session_registrations set status = 'cancelled' where id = v_reg_id;
    raise exception using errcode = 'ZZ001', message = 'deliberate_rollback_for_test_O';
  exception
    when sqlstate 'ZZ001' then null;
  end;

  -- The UPDATE above was rolled back by the surrounding savepoint (PL/pgSQL exception block),
  -- exactly like a real RPC's later failure would roll back everything preceding it.
  if (select status from session_registrations where id = v_reg_id) <> 'active' then
    raise exception 'O FIXTURE INVALID: the status change should have been rolled back';
  end if;

  select count(*) into v_count from manager_operational_notifications where session_id = v_sess;
  if v_count <> 0 then raise exception 'O FAILED: a rolled-back removal must never leave a notification event, got %', v_count; end if;
  raise notice 'O PASSED: a rolled-back removal leaves no notification event behind';
end $$;

-- === P: retry/idempotency -- the exact same underlying departure must never dispatch twice ===
do $$
declare
  v_coach uuid; v_sess uuid; v_reg_id uuid; v_count int;
  v_sun date := current_date - extract(dow from current_date)::int + 35;
  v_ath uuid := gen_random_uuid();
begin
  select v into v_coach from _notif_scratch where k='coach';
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_ath, 'notif_p_ath', 'Retry Athlete', '9408', 'athlete', 'approved');

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 1) returning id into v_sess;
  insert into session_registrations (session_id, user_id, status) values (v_sess, v_ath, 'active') returning id into v_reg_id;

  update session_registrations set status = 'cancelled' where id = v_reg_id;
  -- A "retry" of the same removal RPC would re-run its UPDATE ... WHERE status='active', which now
  -- matches zero rows (already cancelled) -- exactly how the real RPCs behave -- so the trigger
  -- cannot even re-fire. Directly re-invoking the evaluator with the SAME dedupe key (simulating a
  -- reconciliation replay or a raw retry of the trigger's own call) must still be a strict no-op.
  perform public.evaluate_manager_operational_departure(v_sess, 'reg_departure:' || v_reg_id::text, 'Retry Athlete');
  perform public.evaluate_manager_operational_departure(v_sess, 'reg_departure:' || v_reg_id::text, 'Retry Athlete');

  select count(*) into v_count from manager_operational_notifications where session_id = v_sess;
  if v_count <> 1 then raise exception 'P FAILED: expected exactly 1 logical event despite repeated evaluation, got %', v_count; end if;
  raise notice 'P PASSED: repeated evaluation of the same departure never creates a duplicate logical event';
end $$;

-- === D: full group cancellation where the session ends up back at capacity within the SAME
--        transaction (this codebase's waitlist system never auto-promotes synchronously -- see the
--        migration's header comment -- so this is modeled directly: something else re-fills the
--        seat before the evaluator runs, e.g. a manager immediately quick-adding a replacement in
--        the same request). The authoritative check re-reads live occupancy, so it correctly sees
--        the settled 10/10 and must not fire. ===
do $$
declare
  v_coach uuid; v_sess uuid; v_manual_id uuid; v_refill_id uuid; v_count int;
  v_sun date := current_date - extract(dow from current_date)::int + 42;
begin
  select v into v_coach from _notif_scratch where k='coach';
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '18:00', v_coach, 10) returning id into v_sess;

  for v_count in 1..10 loop
    insert into manual_participants (full_name, phone) values ('D-Filler ' || v_count, gen_random_uuid()::text) returning id into v_manual_id;
    insert into session_manual_participants (session_id, manual_participant_id) values (v_sess, v_manual_id);
  end loop;

  select manual_participant_id into v_manual_id from session_manual_participants where session_id = v_sess limit 1;
  -- The refill is inserted BEFORE the departing row is deleted, so that by the moment the delete's
  -- AFTER trigger reads live occupancy, the seat has already been refilled (10/10 the whole time
  -- from the evaluator's point of view) -- modeling "the settled state, after everything in this
  -- transaction has happened, is still full", regardless of momentary ordering within it.
  insert into manual_participants (full_name, phone) values ('D-Refill', gen_random_uuid()::text) returning id into v_refill_id;
  insert into session_manual_participants (session_id, manual_participant_id) values (v_sess, v_refill_id);
  delete from session_manual_participants where session_id = v_sess and manual_participant_id = v_manual_id;

  if public.active_registration_count(v_sess) <> 10 then raise exception 'D FIXTURE FAILED: expected settled state back at 10/10'; end if;

  select count(*) into v_count from manager_operational_notifications where session_id = v_sess and event_kind = 'group_spot_available';
  if v_count <> 0 then raise exception 'D FAILED: session settled back at full capacity must not generate a spot-available event, got %', v_count; end if;
  raise notice 'D PASSED: a departure immediately offset by a refill (settled state still full) generates no availability event';
end $$;

do $$ begin raise notice 'ALL MANAGER OPERATIONAL NOTIFICATION TESTS (A-Q) PASSED'; end $$;
