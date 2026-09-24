-- Bypass #3 closure tests: manager_revert_activity_event's session_registration_status_changed
-- case, plus phantom-slot/chargeability regression coverage across every combination requested.
set client_min_messages to notice;

do $$
declare v_manager uuid;
begin
  select v into v_manager from _move_ids where k='manager';
  create table if not exists _revert_ids (k text primary key, v uuid);
  insert into _revert_ids values ('manager', v_manager) on conflict do nothing;
end $$;

-- Helper pattern used throughout: manually insert a user_activity_events row of type
-- 'session_registration_status_changed' with metadata->>'from' = 'active', pointed at a
-- currently-cancelled registration, then call manager_revert_activity_event on it. This directly
-- exercises the restore-to-active code path regardless of whether the live trigger can currently
-- produce such an event (see the migration's comment: today it can only produce from='cancelled'
-- events; this constructs the from='active' case directly to prove the gate holds if that ever
-- changes, exactly as the coordinator asked to defend against).

-- Test R1: undo cancelled registration -> slot available -> restores as covered.
do $$
declare
  v_manager uuid; v_coach uuid; v_r1 uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_sess uuid; v_reg_id uuid; v_ev_id uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_r1 := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_r1, 'athlete_r1', 'Athlete R1', '0500000401', 'athlete', 'approved');

  v_week_sun := (current_date + 120) - extract(dow from (current_date + 120))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_r1, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_sess;

  perform set_config('app.current_uid', v_r1::text, true);
  v_res := public.register_for_session(v_sess);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R1 setup FAILED: %', v_res; end if;
  select id into v_reg_id from session_registrations where session_id=v_sess and user_id=v_r1;

  update session_registrations set status='cancelled' where id=v_reg_id;

  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_id::text,
    jsonb_build_object('session_id', v_sess, 'user_id', v_r1, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.manager_revert_activity_event(v_ev_id);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R1 FAILED: revert rejected: %', v_res; end if;

  if (select status::text from session_registrations where id=v_reg_id) <> 'active' then
    raise exception 'R1 FAILED: registration not restored to active';
  end if;
  if (select cov.covered from subscription_registration_coverage cov where cov.registration_id=v_reg_id) is not true then
    raise exception 'R1 FAILED: restored registration should be covered=true';
  end if;
  raise notice 'R1 PASSED: undo with available allowance restores as covered';

  create table if not exists _revert_ids2 (k text primary key, v uuid);
  insert into _revert_ids2 values ('r1', v_r1), ('sub_r1', v_sub) on conflict do nothing;
end $$;

-- Test R2/R3: undo when allowance now exhausted -> rejected without consent (state unchanged),
-- then with explicit confirmation -> restores as paid/uncovered.
do $$
declare
  v_manager uuid; v_coach uuid; v_r2 uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_anchor uuid; v_target uuid; v_reg_id uuid; v_ev_id uuid; v_res json;
  v_status_before text;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_r2 := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_r2, 'athlete_r2', 'Athlete R2', '0500000402', 'athlete', 'approved');

  v_week_sun := (current_date + 130) - extract(dow from (current_date + 130))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_r2, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_anchor;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 1) returning id into v_target;

  perform set_config('app.current_uid', v_r2::text, true);
  v_res := public.register_for_session(v_anchor); -- consumes the 1-slot allowance
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R2 setup FAILED anchor: %', v_res; end if;
  v_res := public.register_for_session(v_target, true); -- extra, allowance exhausted
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R2 setup FAILED target: %', v_res; end if;
  select id into v_reg_id from session_registrations where session_id=v_target and user_id=v_r2;

  update session_registrations set status='cancelled' where id=v_reg_id;
  v_status_before := 'cancelled';

  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_id::text,
    jsonb_build_object('session_id', v_target, 'user_id', v_r2, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.manager_revert_activity_event(v_ev_id);
  if (v_res->>'ok')::boolean is true then
    raise exception 'R2 FAILED: undo should have been rejected (allowance_exceeded), got %', v_res;
  end if;
  if v_res->>'error' <> 'subscription_limit_exceeded' or v_res->>'reason' <> 'allowance_exceeded' then
    raise exception 'R2 FAILED: expected subscription_limit_exceeded/allowance_exceeded, got %', v_res;
  end if;
  if (select status::text from session_registrations where id=v_reg_id) <> v_status_before then
    raise exception 'R2 FAILED: cancellation state was disturbed despite rejection';
  end if;
  if (select reverted_at from user_activity_events where id=v_ev_id) is not null then
    raise exception 'R2 FAILED: event was marked reverted despite rejection';
  end if;
  raise notice 'R2 PASSED: allowance-exhausted undo rejected without consent, cancellation state unchanged';

  -- R3: retry with explicit confirmation -> restores as paid/uncovered.
  v_res := public.manager_revert_activity_event(v_ev_id, true);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'R3 FAILED: consented undo should succeed, got %', v_res;
  end if;
  if (select status::text from session_registrations where id=v_reg_id) <> 'active' then
    raise exception 'R3 FAILED: registration not restored to active';
  end if;
  if (select cov.covered from subscription_registration_coverage cov where cov.registration_id=v_reg_id) is not false then
    raise exception 'R3 FAILED: consented restore should be covered=false (paid extra)';
  end if;
  raise notice 'R3 PASSED: consented undo restores as paid/uncovered registration';
end $$;

-- Test R4: undo while frozen -> rejected without consent.
do $$
declare
  v_manager uuid; v_coach uuid; v_r4 uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_sess uuid; v_reg_id uuid; v_ev_id uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_r4 := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_r4, 'athlete_r4', 'Athlete R4', '0500000404', 'athlete', 'approved');

  v_week_sun := (current_date + 140) - extract(dow from (current_date + 140))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_r4, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_sess;

  perform set_config('app.current_uid', v_r4::text, true);
  v_res := public.register_for_session(v_sess);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R4 setup FAILED: %', v_res; end if;
  select id into v_reg_id from session_registrations where session_id=v_sess and user_id=v_r4;
  update session_registrations set status='cancelled' where id=v_reg_id;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_week_sun + 1, v_week_sun + 1);

  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_id::text,
    jsonb_build_object('session_id', v_sess, 'user_id', v_r4, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.manager_revert_activity_event(v_ev_id);
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'frozen' then
    raise exception 'R4 FAILED: expected frozen rejection, got %', v_res;
  end if;
  if (select status::text from session_registrations where id=v_reg_id) <> 'cancelled' then
    raise exception 'R4 FAILED: state disturbed despite rejection';
  end if;
  raise notice 'R4 PASSED: undo while frozen rejected without consent: %', v_res;
end $$;

-- Test R5: undo when tier no longer included -> rejected without consent.
do $$
declare
  v_manager uuid; v_coach uuid; v_r5 uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_sess uuid; v_reg_id uuid; v_ev_id uuid; v_res json;
begin
  select v into v_manager from _revert_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_r5 := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_r5, 'athlete_r5', 'Athlete R5', '0500000405', 'athlete', 'approved');

  v_week_sun := (current_date + 150) - extract(dow from (current_date + 150))::int;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_r5, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_sess;

  perform set_config('app.current_uid', v_r5::text, true);
  v_res := public.register_for_session(v_sess);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'R5 setup FAILED: %', v_res; end if;
  select id into v_reg_id from session_registrations where session_id=v_sess and user_id=v_r5;
  update session_registrations set status='cancelled' where id=v_reg_id;

  -- Retroactively remove the tier's allowance entirely (simulating a subscription edit that
  -- dropped personal-tier coverage since the original cancellation).
  delete from subscription_version_allowances where version_id=v_ver and tier='personal';

  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_id::text,
    jsonb_build_object('session_id', v_sess, 'user_id', v_r5, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.manager_revert_activity_event(v_ev_id);
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'tier_not_included' then
    raise exception 'R5 FAILED: expected tier_not_included rejection, got %', v_res;
  end if;
  raise notice 'R5 PASSED: undo when tier no longer included rejected without consent: %', v_res;
end $$;

do $$ begin raise notice 'ALL REVERT TESTS (R1-R5) PASSED'; end $$;
