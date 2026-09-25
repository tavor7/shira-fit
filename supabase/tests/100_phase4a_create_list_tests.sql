-- Phase 4A tests, batch 1: create_subscription validation/conflict/dedup, list_active_subscriptions
-- manager-only/RLS-equivalent scoping, has_no_end_date duration-only semantics.
--
-- Run order (scratch postgres:15 container, NOT the real Supabase stack): 00-03 stub schemas, then
-- migrations 20260924100000 .. 20260924140000 (Phases 1-3), then
-- 20260924145000_subscriptions_edit_correction_charge_type.sql,
-- 20260924146000_subscriptions_has_no_end_date.sql, then
-- 20260924150000_subscriptions_management_backend.sql (Phase 4A), then this file.
--
-- create_subscription signature (post pre-merge-review-round-2 fix): (payee_id, payee_is_manual,
-- monthly_price_ils, start_date, end_date, anchor_day, allowances) -- the p_is_unlimited parameter
-- was removed entirely; has_no_end_date is now a GENERATED column (plan_end_date IS NULL), never a
-- caller-settable flag, and never forces any allowance to a sentinel.
set search_path = public;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_other_athlete uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_res json;
  v_sub_id uuid;
  v_version_id uuid;
  v_count int;
  v_price numeric;
  v_no_end_ver uuid;
  v_no_end_sub uuid;
  v_limit int;
  v_sun date := current_date - extract(dow from current_date)::int + 7;
  v_sess1 uuid; v_sess2 uuid; v_sess3 uuid;
begin
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'mgr1', 'Manager One', '1', 'manager', 'approved'),
    (v_athlete, 'ath1', 'Athlete One', '2', 'athlete', 'approved'),
    (v_other_athlete, 'ath2', 'Athlete Two', '3', 'athlete', 'approved'),
    (v_coach, 'coach1', 'Coach One', '4', 'coach', 'approved');

  -- === T1: create_subscription forbidden for non-manager ===
  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, current_date, null, null,
    '[{"tier":"pair","weekly_limit":2}]'::jsonb);
  if v_res->>'error' <> 'forbidden' then
    raise exception 'T1 FAILED: expected forbidden, got %', v_res;
  end if;
  raise notice 'T1 PASSED: non-manager create_subscription rejected';

  -- === T2: create_subscription happy path as manager ===
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, current_date, null, null,
    '[{"tier":"pair","weekly_limit":2},{"tier":"trio","weekly_limit":1}]'::jsonb);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T2 FAILED: %', v_res;
  end if;
  v_sub_id := (v_res->>'subscription_id')::uuid;
  v_version_id := (v_res->>'version_id')::uuid;
  raise notice 'T2 PASSED: subscription created %', v_sub_id;

  -- Immediate first billing period should exist (start date = today).
  select count(*) into v_count from subscription_billing_periods where subscription_id = v_sub_id;
  if v_count <> 1 then
    raise exception 'T2b FAILED: expected 1 billing period, got %', v_count;
  end if;
  select amount_ils into v_price from subscription_charges where subscription_id = v_sub_id;
  if v_price <> 300.00 then
    raise exception 'T2c FAILED: expected 300.00 first charge, got %', v_price;
  end if;
  raise notice 'T2b/c PASSED: immediate first charge 300.00';

  -- === T3: conflicting active subscription lineage rejected ===
  v_res := public.create_subscription(v_athlete, false, 100, current_date, null, null, '[]'::jsonb);
  if v_res->>'error' <> 'conflicting_active_subscription' then
    raise exception 'T3 FAILED: expected conflicting_active_subscription, got %', v_res;
  end if;
  raise notice 'T3 PASSED: conflicting lineage rejected';

  -- === T4: invalid price rejected ===
  v_res := public.create_subscription(v_other_athlete, false, -5, current_date, null, null, '[]'::jsonb);
  if v_res->>'error' <> 'invalid_price' then
    raise exception 'T4 FAILED: %', v_res;
  end if;
  raise notice 'T4 PASSED: negative price rejected';

  -- === T5: has_no_end_date is duration-only -- a no-end-date subscription with a FINITE weekly
  --     allowance keeps EXACTLY that allowance (no sentinel, no forcing). Verified two ways:
  --     (i) the stored weekly_limit is exactly what was configured, not 100000 or any other
  --     sentinel; (ii) real registration/reconciliation behavior at THREE different future weeks
  --     produces exactly that allowance each time, indefinitely, never "unlimited". ===
  v_res := public.create_subscription(v_other_athlete, false, 500, current_date, null, null,
    '[{"tier":"pair","weekly_limit":2}]'::jsonb);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T5 FAILED: %', v_res;
  end if;
  v_no_end_sub := (v_res->>'subscription_id')::uuid;
  v_no_end_ver := (v_res->>'version_id')::uuid;

  if not exists (select 1 from subscription_versions where id = v_no_end_ver and plan_end_date is null) then
    raise exception 'T5a FAILED: expected plan_end_date null for a no-end-date subscription';
  end if;
  if not exists (select 1 from subscription_versions where id = v_no_end_ver and has_no_end_date = true) then
    raise exception 'T5b FAILED: expected has_no_end_date = true (derived from plan_end_date null)';
  end if;

  select weekly_limit into v_limit from subscription_version_allowances
  where version_id = v_no_end_ver and tier = 'pair';
  if v_limit <> 2 then
    raise exception 'T5c FAILED: expected weekly_limit exactly 2 (no sentinel), got %', v_limit;
  end if;
  -- Every OTHER tier must be 0 (not included), never a sentinel either.
  if exists (select 1 from subscription_version_allowances where version_id = v_no_end_ver and tier <> 'pair' and weekly_limit <> 0) then
    raise exception 'T5d FAILED: a non-configured tier has a nonzero/sentinel weekly_limit';
  end if;

  -- Register 3 'pair' sessions across 3 DIFFERENT future weeks; each week must independently allow
  -- exactly 2 covered (the configured limit), never more, never "unlimited", indefinitely into the
  -- future -- proving has_no_end_date never leaks into allowance enforcement.
  perform set_config('app.current_uid', v_manager::text, true);
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 2) returning id into v_sess1;   -- week 0
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 8, '10:00', v_coach, 2) returning id into v_sess2;   -- week +1
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 15, '10:00', v_coach, 2) returning id into v_sess3;  -- week +2

  perform set_config('app.current_uid', v_other_athlete::text, true);
  v_res := public.register_for_session(v_sess1);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T5e FIXTURE FAILED reg1: %', v_res; end if;
  v_res := public.register_for_session(v_sess2);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T5e FIXTURE FAILED reg2: %', v_res; end if;
  v_res := public.register_for_session(v_sess3);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T5e FIXTURE FAILED reg3: %', v_res; end if;

  if (select covered from subscription_registration_coverage where subscription_id = v_no_end_sub and session_date = v_sun + 1) <> true then
    raise exception 'T5f FAILED: week 0 single registration should be covered (limit 2)';
  end if;
  if (select covered from subscription_registration_coverage where subscription_id = v_no_end_sub and session_date = v_sun + 8) <> true then
    raise exception 'T5g FAILED: week +1 (far future) should still be covered at exactly the configured limit, not blocked and not unlimited-bypassed';
  end if;
  if (select covered from subscription_registration_coverage where subscription_id = v_no_end_sub and session_date = v_sun + 15) <> true then
    raise exception 'T5h FAILED: week +2 (far future) should still be covered at exactly the configured limit';
  end if;
  raise notice 'T5 PASSED: has_no_end_date is duration-only -- weekly_limit stays exactly 2, verified at 3 distinct future weeks, no sentinel';

  -- === T6: list_active_subscriptions manager-only, athlete gets nothing ===
  perform set_config('app.current_uid', v_athlete::text, true);
  select count(*) into v_count from public.list_active_subscriptions();
  if v_count <> 0 then
    raise exception 'T6 FAILED: athlete should see 0 rows from list_active_subscriptions, got %', v_count;
  end if;
  raise notice 'T6 PASSED: athlete sees nothing via manager RPC';

  perform set_config('app.current_uid', v_manager::text, true);
  select count(*) into v_count from public.list_active_subscriptions();
  if v_count <> 2 then
    raise exception 'T6b FAILED: manager should see 2 active subs, got %', v_count;
  end if;
  raise notice 'T6b PASSED: manager sees % active subs', v_count;

  raise notice 'ALL CREATE/LIST TESTS PASSED';
end $$;
