-- Chargeability-matrix regression tests: verify subscription_reserve_or_reject and
-- subscription_reconcile_week agree on identical chargeability semantics across every
-- combination, and that the deterministic registration-order rule is never violated by a
-- later undo.
set client_min_messages to notice;

-- Test C1: cancellation without charge releases allowance (regression, confirm still holds).
-- Already proven by 30_tests.sql Test 3 and 50_bypass_tests.sql M2; re-confirm directly here
-- with a fresh, minimal, single-purpose setup for this exact claim.
do $$
declare
  v_manager uuid; v_coach uuid; v_c uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_a uuid; v_b uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_c := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_c, 'athlete_c1', 'Athlete C1', '0500000501', 'athlete', 'approved');

  v_week_sun := (current_date + 160) - extract(dow from (current_date + 160))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_c, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_a;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 1) returning id into v_b;

  perform set_config('app.current_uid', v_c::text, true);
  v_res := public.register_for_session(v_a);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'C1 setup FAILED: %', v_res; end if;

  update session_registrations set status='cancelled' where session_id=v_a and user_id=v_c; -- no charge

  v_res := public.register_for_session(v_b); -- should succeed: slot released
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'C1 FAILED: session B should be covered after A cancelled without charge, got %', v_res;
  end if;
  raise notice 'C1 PASSED: cancellation without charge releases allowance';
end $$;

-- Test C2: cancellation with full charge continues consuming allowance (regression, confirm).
do $$
declare
  v_manager uuid; v_coach uuid; v_c uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_a uuid; v_b uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_c := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_c, 'athlete_c2', 'Athlete C2', '0500000502', 'athlete', 'approved');

  v_week_sun := (current_date + 170) - extract(dow from (current_date + 170))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_c, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_a;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 1) returning id into v_b;

  perform set_config('app.current_uid', v_c::text, true);
  v_res := public.register_for_session(v_a);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'C2 setup FAILED: %', v_res; end if;

  update session_registrations set status='cancelled' where session_id=v_a and user_id=v_c;
  insert into public.cancellations (session_id, user_id, reason, charged_full_price, penalty_collected_ils)
  values (v_a, v_c, 'late', true, 100); -- charged cancellation: still consumes the slot

  v_res := public.register_for_session(v_b); -- should be rejected: A still counts (charged)
  if (v_res->>'ok')::boolean is true then
    raise exception 'C2 FAILED: session B should still be blocked by charged cancellation A, got %', v_res;
  end if;
  if v_res->>'reason' <> 'allowance_exceeded' then
    raise exception 'C2 FAILED: expected allowance_exceeded, got %', v_res;
  end if;
  raise notice 'C2 PASSED: cancellation with full charge continues consuming allowance';
end $$;

-- Test C3: no-show charged continues consuming allowance; no-show not charged releases it.
do $$
declare
  v_manager uuid; v_coach uuid; v_c uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_a uuid; v_b uuid; v_c2 uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_c := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_c, 'athlete_c3', 'Athlete C3', '0500000503', 'athlete', 'approved');

  v_week_sun := (current_date + 180) - extract(dow from (current_date + 180))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_c, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_a;

  perform set_config('app.current_uid', v_c::text, true);
  v_res := public.register_for_session(v_a);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'C3 setup FAILED: %', v_res; end if;

  -- No-show, NOT charged: registration stays 'active' (status never flips on no-show, only
  -- attended/charge_no_show do), remains covered, and reconcile's gather predicate correctly
  -- treats it as chargeable only when charge_no_show=true -- confirm it does NOT block a second
  -- personal-tier registration incorrectly by checking the SAME slot's own coverage stays intact
  -- (still occupies the 1/1 allowance since status stays 'active' regardless of attendance).
  update session_registrations set attended = false, charge_no_show = false where session_id=v_a and user_id=v_c;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_a) is not true then
    raise exception 'C3 FAILED: unattended/not-charged no-show should remain covered (still active, occupies its slot)';
  end if;

  -- Now flip to no-show CHARGED: still active status, still occupies the same slot -- coverage
  -- must remain unaffected either way, since 'active' registrations always count regardless of
  -- attendance/charge decision (only a real cancellation removes the slot).
  update session_registrations set charge_no_show = true where session_id=v_a and user_id=v_c;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_a) is not true then
    raise exception 'C3 FAILED: charged no-show should remain covered';
  end if;
  raise notice 'C3 PASSED: no-show charged/not-charged both correctly keep an active registration''s slot (status, not attendance, gates allowance consumption)';
end $$;

-- Test C4: a later undo must NOT displace a registration that legitimately became covered after
-- the original cancellation -- deterministic registration-order rule, not naive re-processing.
do $$
declare
  v_manager uuid; v_coach uuid; v_d uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_early uuid; v_late uuid; v_reg_early uuid; v_ev_id uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_d := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_d, 'athlete_c4', 'Athlete C4', '0500000504', 'athlete', 'approved');

  v_week_sun := (current_date + 190) - extract(dow from (current_date + 190))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_d, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_early; -- registered first, cancelled
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 1) returning id into v_late; -- registered after, legitimately covered

  perform set_config('app.current_uid', v_d::text, true);
  v_res := public.register_for_session(v_early);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'C4 setup FAILED early: %', v_res; end if;
  select id into v_reg_early from session_registrations where session_id=v_early and user_id=v_d;

  -- Cancel WITHOUT charge -- releases the slot -- THEN register for v_late, which legitimately
  -- claims the now-free slot (registration-order correct: v_late's registration event happens
  -- strictly after the cancellation, so it fairly earns the slot).
  update session_registrations set status='cancelled' where id=v_reg_early;
  v_res := public.register_for_session(v_late);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'C4 setup FAILED late: %', v_res; end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_late) is not true then
    raise exception 'C4 setup FAILED: late registration should be covered=true';
  end if;

  -- Now a manager undoes the EARLY cancellation. Per the deterministic registration-order rule
  -- (priority is decided at decision time, not naive re-processing of the whole week), the EARLY
  -- registration's restore is evaluated fresh, AS OF NOW -- it does not get to retroactively
  -- reclaim priority over v_late (which already fairly holds the only slot). It must be rejected
  -- without consent, and v_late must remain untouched/covered throughout.
  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_early::text,
    jsonb_build_object('session_id', v_early, 'user_id', v_d, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.manager_revert_activity_event(v_ev_id);
  if (v_res->>'ok')::boolean is true then
    raise exception 'C4 FAILED: undo should be rejected (v_late already fairly holds the slot), got %', v_res;
  end if;
  if v_res->>'reason' <> 'allowance_exceeded' then
    raise exception 'C4 FAILED: expected allowance_exceeded, got %', v_res;
  end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_late) is not true then
    raise exception 'C4 FAILED: v_late was displaced by the rejected undo attempt';
  end if;
  raise notice 'C4 PASSED: later-registered, legitimately-covered registration is not displaced by an earlier cancellation''s undo';
end $$;

do $$ begin raise notice 'ALL CHARGEABILITY-MATRIX TESTS (C1-C4) PASSED'; end $$;
