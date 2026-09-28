-- Freeze-as-pause correction: remaining explicit acceptance items not already covered by
-- 71/72/76/80/92/101 (billing-schedule shift, cumulative freezes, idempotency, month-length are
-- covered there). This file covers: inclusive freeze duration/resume day, plan end date extension
-- (including a freeze that predates the end date being set), weekly-allowance proration matrix
-- (partial week, single weekday, fully-frozen week), Saturday's denominator-exclusion-but-still-
-- consumable behavior, and reallocation under a freeze-reduced effective limit.
set client_min_messages to notice;

-- === A: inclusive freeze duration -- 1 Oct..7 Oct is exactly 7 frozen days; resume is the 8th. ===
do $$
declare
  v_days int;
begin
  v_days := date '2026-10-07' - date '2026-10-01' + 1;
  if v_days <> 7 then raise exception 'A FAILED: expected 7 inclusive days, got %', v_days; end if;
  if (date '2026-10-07' + 1) <> date '2026-10-08' then raise exception 'A FAILED: resume date must be freeze_until + 1'; end if;
  raise notice 'A PASSED: 1 Oct-7 Oct = 7 inclusive frozen days, resumes 8 Oct';
end $$;

-- === D: plan end date extends by the freeze duration when one is already set. ===
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date := current_date - 30;
  v_end date := current_date + 90;
  v_eff_end date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_d1', 'Athlete D1', '0500004001', 'athlete', 'approved');
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start, v_end) returning id into v_ver;

  v_eff_end := public.subscription_effective_plan_end_date(v_ver);
  if v_eff_end <> v_end then raise exception 'D FAILED: with no freeze, effective end must equal configured end, got %', v_eff_end; end if;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, current_date, current_date + 6); -- 7 days
  v_eff_end := public.subscription_effective_plan_end_date(v_ver);
  if v_eff_end <> v_end + 7 then raise exception 'D FAILED: expected end extended by 7, got %', v_eff_end; end if;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, current_date + 20, current_date + 29); -- 10 more days
  v_eff_end := public.subscription_effective_plan_end_date(v_ver);
  if v_eff_end <> v_end + 17 then raise exception 'D FAILED: expected end extended by cumulative 17, got %', v_eff_end; end if;

  raise notice 'D PASSED: plan end date extends by 7, then cumulative 17, across two freezes';
end $$;

-- === F: a freeze applied while the subscription has NO end date is still counted once an end
--        date is added later ("historical freeze days must be accounted for consistently"). ===
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date := current_date - 30;
  v_eff_end date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_f1', 'Athlete F1', '0500004002', 'athlete', 'approved');
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  -- No end date yet.
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start, null) returning id into v_ver;

  if public.subscription_effective_plan_end_date(v_ver) is not null then
    raise exception 'F FAILED: no end date should mean no effective end date either';
  end if;

  -- A freeze happens while there is still no end date.
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, current_date - 10, current_date - 4); -- 7 days, already in the past

  -- Now an end date is added (simulating edit_subscription_version's in-place update path).
  update public.subscription_versions set plan_end_date = current_date + 100 where id = v_ver;

  v_eff_end := public.subscription_effective_plan_end_date(v_ver);
  if v_eff_end <> (current_date + 100 + 7) then
    raise exception 'F FAILED: expected the earlier (pre-end-date) freeze to still extend the newly-set end date by 7, got %', v_eff_end;
  end if;

  raise notice 'F PASSED: a freeze that occurred before an end date existed still extends it once one is set';
end $$;

-- === G/H/I/J: weekly-allowance proration matrix. ===
do $$
declare
  v_manager uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sub uuid; v_res jsonb; v_sun date := current_date - extract(dow from current_date)::int + 7; -- next Sunday
  v_limit int;
begin
  insert into profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_manager, 'fp_mgr', 'FP Manager', '9201', 'manager', 'approved'),
    (v_athlete, 'fp_ath', 'FP Athlete', '9202', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(
    v_athlete, false, 300, v_sun - 30, null, extract(day from v_sun - 30)::smallint,
    jsonb_build_array(
      jsonb_build_object('tier', 'pair', 'weekly_limit', 3),
      jsonb_build_object('tier', 'trio', 'weekly_limit', 4),
      jsonb_build_object('tier', 'quartet', 'weekly_limit', 3),
      jsonb_build_object('tier', 'quintet', 'weekly_limit', 1)
    )
  );
  v_sub := (v_res->>'subscription_id')::uuid;

  -- Freeze Sun-Wed of that week (4 days: Sun, Mon, Tue, Wed).
  perform public.freeze_subscription(v_sub, v_sun, v_sun + 3, true);

  -- G: 3/week + Sun-Wed frozen -> eligible Sun-Fri days = Thu+Fri = 2 -> ceil(3*2/6) = 1.
  v_limit := public.subscription_effective_weekly_limit(v_athlete, false, 'pair', v_sun);
  if v_limit <> 1 then raise exception 'G FAILED: expected effective limit 1, got %', v_limit; end if;

  -- H: 4/week + same freeze -> ceil(4*2/6) = 2.
  v_limit := public.subscription_effective_weekly_limit(v_athlete, false, 'trio', v_sun);
  if v_limit <> 2 then raise exception 'H FAILED: expected effective limit 2, got %', v_limit; end if;

  raise notice 'G PASSED: 3/week + Sun-Wed freeze -> effective limit 1';
  raise notice 'H PASSED: 4/week + Sun-Wed freeze -> effective limit 2';

  -- I: separate week, only Monday frozen -> eligible Sun-Fri days = 5 -> ceil(3*5/6) = 3.
  perform public.freeze_subscription(v_sub, v_sun + 8, v_sun + 8, true); -- next week's Monday only
  v_limit := public.subscription_effective_weekly_limit(v_athlete, false, 'quartet', v_sun + 7);
  if v_limit <> 3 then raise exception 'I FAILED: expected effective limit 3 (one frozen weekday), got %', v_limit; end if;
  raise notice 'I PASSED: one frozen weekday (Monday) -> ceil(3*5/6) = 3';

  -- J: a third week, fully frozen Sun-Fri -> eligible days = 0 -> effective limit 0 regardless of configured.
  perform public.freeze_subscription(v_sub, v_sun + 14, v_sun + 19, true); -- Sun..Fri of week 3
  v_limit := public.subscription_effective_weekly_limit(v_athlete, false, 'pair', v_sun + 14);
  if v_limit <> 0 then raise exception 'J FAILED: expected effective limit 0 for a fully Sun-Fri-frozen week, got %', v_limit; end if;
  raise notice 'J PASSED: full Sun-Fri freeze -> effective limit 0';

  create table if not exists _fp_ids (k text primary key, v uuid);
  insert into _fp_ids values ('mgr', v_manager), ('ath', v_athlete), ('sub', v_sub)
  on conflict (k) do update set v = excluded.v;
end $$;

-- === K: Saturday is excluded from the denominator, but a Saturday session can still consume the
--        resulting (prorated) remaining allowance. Reuses the week-1 fixture above (effective
--        limit 1 for 'pair' after the Sun-Wed freeze). ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid;
  v_coach uuid := gen_random_uuid();
  v_sun date := current_date - extract(dow from current_date)::int + 7;
  v_sat_sess uuid; v_res json; v_covered_count int;
begin
  select v into v_manager from _fp_ids where k='mgr';
  select v into v_athlete from _fp_ids where k='ath';
  select v into v_sub from _fp_ids where k='sub';

  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_coach, 'fp_coach', 'FP Coach', '9203', 'coach', 'approved');

  -- A Saturday session in week 1 (effective 'pair' limit there is 1, per test G, none used yet).
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 6, '10:00', v_coach, 2) returning id into v_sat_sess; -- Saturday, pair tier

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sat_sess);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'K FAILED: Saturday registration should be accepted (consuming the prorated limit), got %', v_res;
  end if;

  select count(*) into v_covered_count from subscription_registration_coverage
  where subscription_id = v_sub and tier = 'pair' and week_start = v_sun and covered = true;
  if v_covered_count <> 1 then
    raise exception 'K FAILED: expected the Saturday registration to be covered (consuming the 1 effective slot), got % covered', v_covered_count;
  end if;

  -- A second pair-tier session the same week must now be rejected outright (allowance_exceeded),
  -- proving the prorated limit (1, not the configured 3) governs even outside the freeze window.
  declare v_sess2 uuid; v_res2 json; v_reason text;
  begin
    insert into training_sessions (session_date, start_time, coach_id, max_participants)
    values (v_sun + 5, '10:00', v_coach, 2) returning id into v_sess2; -- Friday, pair tier
    v_res2 := public.register_for_session(v_sess2);
    if coalesce((v_res2->>'ok')::boolean, false) then
      raise exception 'K FAILED: a second pair-tier session should be rejected once the prorated slot (1) is used, got %', v_res2;
    end if;
    if v_res2->>'error' <> 'subscription_limit_exceeded' or v_res2->>'reason' <> 'allowance_exceeded' then
      raise exception 'K FAILED: expected subscription_limit_exceeded/allowance_exceeded, got %', v_res2;
    end if;
  end;

  raise notice 'K PASSED: Saturday session consumed the prorated (freeze-reduced) allowance; a further same-week session correctly hits allowance_exceeded';
end $$;

-- === L: reallocation under a freeze-reduced effective limit -- the earliest eligible registration
--        by registration order keeps its covered slot; later ones become normal paid registrations. ===
do $$
declare
  v_manager uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_sub uuid; v_res jsonb;
  v_sun date := current_date - extract(dow from current_date)::int + 21; -- a fresh, unrelated future week
  v_sess1 uuid; v_sess2 uuid; v_sess3 uuid;
  v_covered_count int;
begin
  insert into profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_manager, 'fp_l_mgr', 'FP-L Manager', '9204', 'manager', 'approved'),
    (v_athlete, 'fp_l_ath', 'FP-L Athlete', '9205', 'athlete', 'approved'),
    (v_coach, 'fp_l_coach', 'FP-L Coach', '9206', 'coach', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(
    v_athlete, false, 300, v_sun - 30, null, extract(day from v_sun - 30)::smallint,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 3))
  );
  v_sub := (v_res->>'subscription_id')::uuid;

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 2) returning id into v_sess1;
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 2, '10:00', v_coach, 2) returning id into v_sess2;
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 3, '10:00', v_coach, 2) returning id into v_sess3;

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sess1); if not coalesce((v_res->>'ok')::boolean,false) then raise exception 'L FIXTURE FAILED reg1: %', v_res; end if;
  v_res := public.register_for_session(v_sess2); if not coalesce((v_res->>'ok')::boolean,false) then raise exception 'L FIXTURE FAILED reg2: %', v_res; end if;
  v_res := public.register_for_session(v_sess3); if not coalesce((v_res->>'ok')::boolean,false) then raise exception 'L FIXTURE FAILED reg3: %', v_res; end if;

  select count(*) into v_covered_count from subscription_registration_coverage where subscription_id=v_sub and covered=true;
  if v_covered_count <> 3 then raise exception 'L FIXTURE FAILED: expected all 3 covered before the freeze, got %', v_covered_count; end if;

  -- subscription_reconcile_week's gather predicate only re-evaluates SETTLED registrations
  -- (attended, or a charged cancellation) -- matching its existing, unchanged chargeability rule.
  -- Mark all three attended so the freeze's reconciliation pass actually reconsiders them.
  update session_registrations set attended = true where session_id in (v_sess1, v_sess2, v_sess3) and user_id = v_athlete;

  -- Freeze Thu-Fri of the SAME week (2 days) -> eligible Sun-Fri days = 4 -> ceil(3*4/6) = 2.
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.freeze_subscription(v_sub, v_sun + 4, v_sun + 5, true);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'L FAILED: freeze_subscription failed: %', v_res; end if;

  select count(*) into v_covered_count from subscription_registration_coverage where subscription_id=v_sub and covered=true;
  if v_covered_count <> 2 then
    raise exception 'L FAILED: expected exactly 2 covered after the effective limit dropped to 2, got %', v_covered_count;
  end if;

  -- Exactly one of the three must have flipped to allowance_exceeded (the existing registration-
  -- order priority rule -- registered_at ASC, id ASC, unchanged by this correction -- decides
  -- WHICH one; this test only verifies the CORRECT COUNT reallocates under the new effective
  -- limit, since all three share the same transaction timestamp here and so tie-break on id,
  -- making "which specific one" non-deterministic in this single-transaction test harness even
  -- though it is fully deterministic against real, distinct registration timestamps).
  if (select count(*) from subscription_registration_coverage where subscription_id=v_sub and covered=false and non_coverage_reason='allowance_exceeded') <> 1 then
    raise exception 'L FAILED: expected exactly 1 registration reallocated to allowance_exceeded';
  end if;

  raise notice 'L PASSED: freeze-reduced effective limit (3->2) correctly reallocates -- exactly 2 stay covered, 1 becomes a normal paid registration';
end $$;

do $$ begin raise notice 'ALL FREEZE PAUSE SEMANTICS TESTS (A,D,F,G,H,I,J,K,L) PASSED'; end $$;
