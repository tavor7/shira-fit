-- Bypass-closure tests: staff_move_session_participant + session-series roster auto-copy.
set client_min_messages to notice;

-- Fixtures: a manager + a coach + 3 athletes reused via existing _test_ids from 30_tests.sql,
-- plus a fresh manual participant and a batch of sessions for move/series scenarios.
do $$
declare
  v_manager uuid; v_coach uuid; v_mp uuid;
begin
  select v into v_manager from _test_ids where k='manager';
  select v into v_coach from _test_ids where k='coach';

  insert into public.manual_participants (id, full_name, phone)
  values (gen_random_uuid(), 'Manual Move Person', '0500000099')
  returning id into v_mp;

  perform set_config('app.current_uid', v_manager::text, true);

  create table if not exists _move_ids (k text primary key, v uuid);
  insert into _move_ids values ('manager', v_manager), ('coach', v_coach), ('mp', v_mp);
end $$;

-- Test M1: covered athlete moved to another covered session (same tier/week, allowance has room).
do $$
declare
  v_manager uuid; v_coach uuid; v_e uuid;
  v_sub uuid; v_ver uuid;
  v_week_sun date;
  v_src uuid; v_dst uuid;
  v_res json;
begin
  select v into v_manager from _move_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  v_e := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_e, 'athlete_e', 'Athlete E', '0500000010', 'athlete', 'approved');

  v_week_sun := (current_date + 40) - extract(dow from (current_date + 40))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_e, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 30, 300, 1, v_week_sun - 30) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 2);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 3) returning id into v_src; -- trio
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 3) returning id into v_dst; -- trio

  perform set_config('app.current_uid', v_e::text, true);
  v_res := public.register_for_session(v_src);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M1 FAILED: initial reg rejected: %', v_res; end if;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst, v_e, null);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M1 FAILED: move rejected: %', v_res; end if;

  if exists (select 1 from session_registrations where session_id=v_src and user_id=v_e and status='active') then
    raise exception 'M1 FAILED: source still active after move';
  end if;
  if not exists (select 1 from session_registrations where session_id=v_dst and user_id=v_e and status='active') then
    raise exception 'M1 FAILED: destination not active after move';
  end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id
       where r.session_id=v_dst and r.user_id=v_e) is not true then
    raise exception 'M1 FAILED: destination not covered=true';
  end if;
  raise notice 'M1 PASSED: covered athlete moved to another covered session, source cleared, dest covered=true';

  create table if not exists _move_ids2 (k text primary key, v uuid);
  insert into _move_ids2 values ('e', v_e), ('sub_e', v_sub), ('ver_e', v_ver), ('src1', v_src), ('dst1', v_dst)
  on conflict do nothing;
end $$;

-- Test M2: move from one week's allowance pool releases source; a third session (already extra-
-- paid due to exhausted allowance) becomes coverable once the move frees a slot via reconcile.
do $$
declare
  v_e uuid; v_manager uuid; v_coach uuid;
  v_week_sun date; v_dst2 uuid; v_extra uuid;
  v_res json;
begin
  select v into v_e from _move_ids2 where k='e';
  select v into v_manager from _move_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  select v into v_week_sun from (select (current_date+40) - extract(dow from (current_date+40))::int as v) x;

  -- Athlete E currently has: dst1 (covered, trio) as their 1 of 2 allowance. Register a 2nd
  -- covered trio session, then a 3rd that should be extra-paid (allowance exceeded).
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 3, '09:00', v_coach, 3) returning id into v_dst2;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 4, '09:00', v_coach, 3) returning id into v_extra;

  perform set_config('app.current_uid', v_e::text, true);
  v_res := public.register_for_session(v_dst2);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M2 FAILED: dst2 reg rejected: %', v_res; end if;

  v_res := public.register_for_session(v_extra, true); -- accept_extra, since allowance (2) now full
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M2 FAILED: extra reg rejected: %', v_res; end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id
       where r.session_id=v_extra) is not false then
    raise exception 'M2 FAILED: extra session should be covered=false initially';
  end if;

  -- Now move athlete E out of dst1 (freeing 1 of the 2 trio slots for that week) to a
  -- personal-tier session (different tier -> independent pool, doesn't consume trio allowance).
  declare v_personal uuid; v_dst1 uuid;
  begin
    select v into v_dst1 from _move_ids2 where k='dst1';
    insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
    values (v_week_sun + 5, '09:00', v_coach, 1) returning id into v_personal; -- personal tier, not included -> accept_extra needed
    perform set_config('app.current_uid', v_manager::text, true);
    v_res := public.staff_move_session_participant(v_dst1, v_personal, v_e, null, false, false, false, true);
    if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M2 FAILED: release move rejected: %', v_res; end if;
  end;

  -- The trio slot vacated by dst1 should reconcile-reallocate to v_extra (created earlier,
  -- registered_at after dst2 but was allowance_exceeded) once its own chargeable state changes.
  perform set_config('app.current_uid', v_manager::text, true);
  update session_registrations set attended = true where session_id = v_extra and user_id = v_e;

  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id
       where r.session_id=v_extra) is not true then
    raise exception 'M2 FAILED: extra session should be reallocated covered=true after source release + its own attendance flip';
  end if;
  raise notice 'M2 PASSED: source allowance correctly released by move, reallocated to a previously extra-paid registration';
end $$;

-- Test M3/M4: destination exceeds allowance -> rejected without consent (source/destination/
-- anchor fully untouched), then the same move with explicit consent succeeds as a paid extra.
--
-- Scenario, corrected after testing revealed that a same-tier move must release the source
-- BEFORE the destination is decided (see the code comment in staff_move_session_participant):
-- moving an athlete's ONLY registration in a tier/week always has room by definition once
-- released, so to genuinely trigger allowance_exceeded the athlete needs an ANCHOR covered
-- registration that is NOT being moved (so releasing the moved one doesn't free the pool), plus
-- a SEPARATE, already-uncovered (extra-paid) registration that IS the one being moved.
do $$
declare
  v_g uuid; v_manager uuid; v_coach uuid; v_week_sun date;
  v_sub uuid; v_ver uuid;
  v_anchor uuid; v_src uuid; v_dst_full uuid;
  v_res json;
  v_src_status_before text;
  v_dst_count_before int;
begin
  v_g := gen_random_uuid();
  select v into v_manager from _move_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_g, 'athlete_g', 'Athlete G', '0500000012', 'athlete', 'approved');

  v_week_sun := (current_date + 60) - extract(dow from (current_date + 60))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_g, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'quartet', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 4) returning id into v_anchor; -- quartet, covered, NOT moved
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 4) returning id into v_src; -- quartet, extra-paid, IS moved
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 3, '09:00', v_coach, 4) returning id into v_dst_full; -- quartet, destination

  perform set_config('app.current_uid', v_g::text, true);
  v_res := public.register_for_session(v_anchor); -- consumes the 1-slot quartet allowance
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'FAILED setup anchor: %', v_res; end if;
  v_res := public.register_for_session(v_src, true); -- allowance already used by anchor -> extra, accept_extra
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'FAILED setup src: %', v_res; end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_src) is not false then
    raise exception 'FAILED setup: src should be covered=false (extra) before the move';
  end if;

  v_src_status_before := (select status::text from session_registrations where session_id=v_src and user_id=v_g);
  v_dst_count_before := (select count(*) from session_registrations where session_id=v_dst_full and status='active');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.staff_move_session_participant(v_src, v_dst_full, v_g, null);
  if (v_res->>'ok')::boolean is true then
    raise exception 'FAILED: move should have been rejected (allowance_exceeded), got %', v_res;
  end if;
  if v_res->>'error' <> 'subscription_limit_exceeded' or v_res->>'reason' <> 'allowance_exceeded' then
    raise exception 'FAILED: expected subscription_limit_exceeded/allowance_exceeded, got %', v_res;
  end if;

  if (select status::text from session_registrations where session_id=v_src and user_id=v_g) <> v_src_status_before then
    raise exception 'FAILED: source registration was modified despite rejection';
  end if;
  if (select count(*) from session_registrations where session_id=v_dst_full and status='active') <> v_dst_count_before then
    raise exception 'FAILED: destination gained a registration despite rejection';
  end if;
  -- Also verify the anchor (untouched, unrelated registration) is still exactly as it was --
  -- proof the compensating restore didn't disturb anything beyond the source itself.
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id where r.session_id=v_anchor) is not true then
    raise exception 'FAILED: anchor registration coverage was disturbed by the rejected move';
  end if;
  raise notice 'M3 PASSED: allowance-exceeded move rejected without consent, source/destination/anchor fully untouched';

  -- Now retry with explicit consent -> completes as a paid/extra destination registration.
  v_res := public.staff_move_session_participant(v_src, v_dst_full, v_g, null, false, false, false, true);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'M4 FAILED: consented move should succeed, got %', v_res;
  end if;
  if exists (select 1 from session_registrations where session_id=v_src and user_id=v_g and status='active') then
    raise exception 'M4 FAILED: source still active after consented move';
  end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_registrations r on r.id=cov.registration_id
       where r.session_id=v_dst_full and r.user_id=v_g) is not false then
    raise exception 'M4 FAILED: destination should be covered=false (paid extra) after consented over-allowance move';
  end if;
  raise notice 'M4 PASSED: consented move completed, destination is a paid/extra registration';

  create table if not exists _move_ids3 (k text primary key, v uuid);
  insert into _move_ids3 values ('g', v_g), ('sub_g', v_sub), ('ver_g', v_ver), ('dst_full', v_dst_full)
  on conflict do nothing;
end $$;

-- Test M5: move to a frozen destination -> rejected without consent, untouched.
do $$
declare
  v_g uuid; v_sub uuid; v_manager uuid; v_coach uuid; v_week_sun date;
  v_src2 uuid; v_frozen_dst uuid; v_res json;
begin
  select v into v_g from _move_ids3 where k='g';
  select v into v_sub from _move_ids3 where k='sub_g';
  select v into v_manager from _move_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  select v into v_week_sun from (select (current_date+60) - extract(dow from (current_date+60))::int as v) x;

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 4, '09:00', v_coach, 4) returning id into v_src2;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 5, '09:00', v_coach, 4) returning id into v_frozen_dst;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_week_sun + 5, v_week_sun + 5);

  perform set_config('app.current_uid', v_g::text, true);
  v_res := public.register_for_session(v_src2, true); -- extra (allowance already fully used above)
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M5 setup FAILED: %', v_res; end if;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.staff_move_session_participant(v_src2, v_frozen_dst, v_g, null);
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'frozen' then
    raise exception 'M5 FAILED: expected frozen rejection, got %', v_res;
  end if;
  if not exists (select 1 from session_registrations where session_id=v_src2 and user_id=v_g and status='active') then
    raise exception 'M5 FAILED: source was touched despite rejection';
  end if;
  raise notice 'M5 PASSED: move to frozen destination rejected without consent, source untouched: %', v_res;
end $$;

-- Test M6: move to a tier-not-included destination -> rejected without consent.
do $$
declare
  v_g uuid; v_manager uuid; v_coach uuid; v_week_sun date;
  v_src3 uuid; v_ni_dst uuid; v_res json;
begin
  select v into v_g from _move_ids3 where k='g';
  select v into v_manager from _move_ids where k='manager';
  select v into v_coach from _move_ids where k='coach';
  select v into v_week_sun from (select (current_date+60) - extract(dow from (current_date+60))::int as v) x;

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 6, '09:00', v_coach, 4) returning id into v_src3; -- still quartet, Saturday of same week
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 4, '10:00', v_coach, 1) returning id into v_ni_dst; -- personal tier, not configured -> tier_not_included

  perform set_config('app.current_uid', v_g::text, true);
  v_res := public.register_for_session(v_src3, true);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'M6 setup FAILED: %', v_res; end if;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.staff_move_session_participant(v_src3, v_ni_dst, v_g, null);
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'tier_not_included' then
    raise exception 'M6 FAILED: expected tier_not_included rejection, got %', v_res;
  end if;
  raise notice 'M6 PASSED: move to tier-not-included destination rejected without consent: %', v_res;
end $$;

do $$ begin raise notice 'ALL MOVE TESTS PASSED'; end $$;
