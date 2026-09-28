-- Athlete-facing subscription read model tests for get_my_subscription().
--
-- Run order (scratch container, NOT the real Supabase stack): 00_stub_schema.sql,
-- 01_move_stub_schema.sql, 02_revert_stub_schema.sql, 04_pre_subscription_rpc_stub.sql (skip
-- 03_family_stub_schema.sql -- unrelated to subscriptions and not needed here), then migrations
-- 20260924100000 .. 20260924150000, 20260925120112_drop_pre_subscription_rpc_overloads.sql, then
-- 20260928080000_subscriptions_athlete_read_model.sql, then this file.
--
-- Covers: no subscription, active subscription with partial usage, exhausted allowance, several
-- included tiers, frozen subscription, plan with/without an end date, and that the RPC never
-- leaks one payee's subscription to another caller (auth.uid()-only scoping, no client-supplied id
-- accepted at all).
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_other_athlete uuid := gen_random_uuid();
  v_sub uuid;
  v_ver uuid;
  v_res jsonb;
  v_sun date := current_date - extract(dow from current_date)::int;
  v_sess1 uuid; v_sess2 uuid; v_sess3 uuid;
begin
  insert into profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_manager, 'ath_sub_mgr', 'Athlete-Sub Manager', '9101', 'manager', 'approved'),
    (v_coach, 'ath_sub_coach', 'Athlete-Sub Coach', '9102', 'coach', 'approved'),
    (v_athlete, 'ath_sub_ath', 'Athlete-Sub Athlete', '9103', 'athlete', 'approved'),
    (v_other_athlete, 'ath_sub_other', 'Athlete-Sub Other', '9104', 'athlete', 'approved');

  -- === T1: no subscription at all ===
  perform set_config('app.current_uid', v_other_athlete::text, true);
  v_res := public.get_my_subscription();
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T1 FAILED: expected ok=true, got %', v_res;
  end if;
  if coalesce((v_res->>'has_subscription')::boolean, true) then
    raise exception 'T1 FAILED: expected has_subscription=false for athlete with no subscription, got %', v_res;
  end if;
  raise notice 'T1 PASSED: no subscription -> has_subscription=false';

  -- === Fixture: active subscription, no end date, two included tiers (pair=2 quartet=1) ===
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(
    v_athlete, false, 350, current_date - 10, null, extract(day from current_date - 10)::smallint,
    jsonb_build_array(
      jsonb_build_object('tier', 'pair', 'weekly_limit', 2),
      jsonb_build_object('tier', 'quartet', 'weekly_limit', 1)
    )
  );
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'FIXTURE FAILED create_subscription: %', v_res;
  end if;
  v_sub := (v_res->>'subscription_id')::uuid;
  v_ver := (v_res->>'version_id')::uuid;

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '23:30', v_coach, 2) returning id into v_sess1; -- pair
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 3, '23:30', v_coach, 4) returning id into v_sess2; -- quartet

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sess1);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FIXTURE FAILED reg1: %', v_res; end if;
  v_res := public.register_for_session(v_sess2);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FIXTURE FAILED reg2: %', v_res; end if;

  -- === T2: active subscription surfaces price/dates and correct partial usage for both tiers ===
  v_res := public.get_my_subscription();
  if not coalesce((v_res->>'has_subscription')::boolean, false) then
    raise exception 'T2 FAILED: expected has_subscription=true, got %', v_res;
  end if;
  if coalesce((v_res->>'is_frozen')::boolean, true) then
    raise exception 'T2 FAILED: expected is_frozen=false, got %', v_res;
  end if;
  if (v_res->>'monthly_price_ils')::numeric <> 350 then
    raise exception 'T2 FAILED: expected monthly_price_ils=350, got %', v_res->>'monthly_price_ils';
  end if;
  if not coalesce((v_res->>'has_no_end_date')::boolean, false) then
    raise exception 'T2 FAILED: expected has_no_end_date=true, got %', v_res;
  end if;
  if v_res->>'plan_end_date' is not null then
    raise exception 'T2 FAILED: expected plan_end_date=null, got %', v_res->>'plan_end_date';
  end if;
  if v_res->>'next_billing_date' is null then
    raise exception 'T2 FAILED: expected a non-null next_billing_date, got %', v_res;
  end if;

  declare
    v_pair jsonb;
    v_quartet jsonb;
  begin
    select u into v_pair from jsonb_array_elements(v_res->'weekly_usage') u where u->>'tier' = 'pair';
    select u into v_quartet from jsonb_array_elements(v_res->'weekly_usage') u where u->>'tier' = 'quartet';
    if v_pair is null or v_quartet is null then
      raise exception 'T2 FAILED: expected both pair and quartet tiers in weekly_usage, got %', v_res->'weekly_usage';
    end if;
    if (v_pair->>'used')::int <> 1 or (v_pair->>'configured_weekly_limit')::int <> 2 or (v_pair->>'effective_weekly_limit')::int <> 2 then
      raise exception 'T2 FAILED: expected pair used=1/configured=2/effective=2 (no freeze this week), got %', v_pair;
    end if;
    if (v_quartet->>'used')::int <> 1 or (v_quartet->>'configured_weekly_limit')::int <> 1 or (v_quartet->>'effective_weekly_limit')::int <> 1 then
      raise exception 'T2 FAILED: expected quartet used=1/configured=1/effective=1 (exhausted), got %', v_quartet;
    end if;
  end;
  raise notice 'T2 PASSED: active subscription with two included tiers, correct partial + exhausted usage';

  -- === T3: pushing pair to its exact limit (2) shows used=limit, no allowance_exceeded needed ===
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 4, '23:30', v_coach, 2) returning id into v_sess3; -- pair, 2nd of the week
  v_res := public.register_for_session(v_sess3);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FIXTURE FAILED reg3: %', v_res; end if;

  v_res := public.get_my_subscription();
  declare
    v_pair jsonb;
  begin
    select u into v_pair from jsonb_array_elements(v_res->'weekly_usage') u where u->>'tier' = 'pair';
    if (v_pair->>'used')::int <> 2 or (v_pair->>'effective_weekly_limit')::int <> 2 then
      raise exception 'T3 FAILED: expected pair used=2 (exhausted, effective_weekly_limit=2), got %', v_pair;
    end if;
  end;
  raise notice 'T3 PASSED: exhausted tier reports used == effective_weekly_limit';

  -- === T4: freezing the subscription (as manager) flips is_frozen and exposes current_freeze ===
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.freeze_subscription(v_sub, current_date, current_date + 3, true);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'FIXTURE FAILED freeze_subscription: %', v_res;
  end if;

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.get_my_subscription();
  if not coalesce((v_res->>'is_frozen')::boolean, false) then
    raise exception 'T4 FAILED: expected is_frozen=true after an active freeze, got %', v_res;
  end if;
  if v_res->'current_freeze' is null or v_res->'current_freeze' = 'null'::jsonb then
    raise exception 'T4 FAILED: expected current_freeze to be populated, got %', v_res;
  end if;
  if (v_res->'current_freeze'->>'freeze_until') <> to_char(current_date + 3, 'YYYY-MM-DD') then
    raise exception 'T4 FAILED: unexpected freeze_until, got %', v_res->'current_freeze';
  end if;
  raise notice 'T4 PASSED: active freeze surfaces is_frozen=true and current_freeze window';

  -- === T5: self-scoping -- the OTHER athlete still sees no subscription of their own, never v_athlete's ===
  perform set_config('app.current_uid', v_other_athlete::text, true);
  v_res := public.get_my_subscription();
  if coalesce((v_res->>'has_subscription')::boolean, true) then
    raise exception 'T5 FAILED: expected has_subscription=false for the OTHER athlete, got %', v_res;
  end if;
  raise notice 'T5 PASSED: get_my_subscription() never leaks another payee''s subscription';

  -- === T6: not authenticated ===
  perform set_config('app.current_uid', '', true);
  v_res := public.get_my_subscription();
  if coalesce((v_res->>'ok')::boolean, true) or (v_res->>'error') <> 'not_authenticated' then
    raise exception 'T6 FAILED: expected {ok:false, error:not_authenticated} with no auth.uid(), got %', v_res;
  end if;
  raise notice 'T6 PASSED: null auth.uid() -> not_authenticated';

  -- === T7: a subscription WITH an end date reports has_no_end_date=false and the exact date ===
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(
    v_other_athlete, false, 200, current_date - 5, current_date + 60, extract(day from current_date - 5)::smallint,
    jsonb_build_array(jsonb_build_object('tier', 'personal', 'weekly_limit', 1))
  );
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'FIXTURE FAILED create_subscription (end-dated): %', v_res;
  end if;

  perform set_config('app.current_uid', v_other_athlete::text, true);
  v_res := public.get_my_subscription();
  if coalesce((v_res->>'has_no_end_date')::boolean, true) then
    raise exception 'T7 FAILED: expected has_no_end_date=false, got %', v_res;
  end if;
  if (v_res->>'plan_end_date') <> to_char(current_date + 60, 'YYYY-MM-DD') then
    raise exception 'T7 FAILED: expected plan_end_date=%, got %', current_date + 60, v_res->>'plan_end_date';
  end if;
  raise notice 'T7 PASSED: end-dated plan reports has_no_end_date=false and the correct plan_end_date';

  raise notice 'ALL athlete subscription read-model tests passed';
end $$;
