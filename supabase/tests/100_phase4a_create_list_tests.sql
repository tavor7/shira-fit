-- Phase 4A tests, batch 1: create_subscription validation/conflict/dedup, list_active_subscriptions
-- manager-only/RLS-equivalent scoping.
--
-- Run order (scratch postgres:15 container, NOT the real Supabase stack): 00-03 stub schemas, then
-- migrations 20260924100000 .. 20260924140000 (Phases 1-3), then
-- 20260924145000_subscriptions_edit_correction_charge_type.sql, then
-- 20260924150000_subscriptions_management_backend.sql (Phase 4A), then this file.
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
begin
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'mgr1', 'Manager One', '1', 'manager', 'approved'),
    (v_athlete, 'ath1', 'Athlete One', '2', 'athlete', 'approved'),
    (v_other_athlete, 'ath2', 'Athlete Two', '3', 'athlete', 'approved'),
    (v_coach, 'coach1', 'Coach One', '4', 'coach', 'approved');

  -- === T1: create_subscription forbidden for non-manager ===
  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, current_date, null, false, null,
    '[{"tier":"pair","weekly_limit":2}]'::jsonb);
  if v_res->>'error' <> 'forbidden' then
    raise exception 'T1 FAILED: expected forbidden, got %', v_res;
  end if;
  raise notice 'T1 PASSED: non-manager create_subscription rejected';

  -- === T2: create_subscription happy path as manager ===
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, current_date, null, false, null,
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
  v_res := public.create_subscription(v_athlete, false, 100, current_date, null, false, null, '[]'::jsonb);
  if v_res->>'error' <> 'conflicting_active_subscription' then
    raise exception 'T3 FAILED: expected conflicting_active_subscription, got %', v_res;
  end if;
  raise notice 'T3 PASSED: conflicting lineage rejected';

  -- === T4: invalid price rejected ===
  v_res := public.create_subscription(v_other_athlete, false, -5, current_date, null, false, null, '[]'::jsonb);
  if v_res->>'error' <> 'invalid_price' then
    raise exception 'T4 FAILED: %', v_res;
  end if;
  raise notice 'T4 PASSED: negative price rejected';

  -- === T5: unlimited flag forces sentinel allowance ===
  v_res := public.create_subscription(v_other_athlete, false, 500, current_date, null, true, null,
    '[{"tier":"personal","weekly_limit":1}]'::jsonb);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T5 FAILED: %', v_res;
  end if;
  if not exists (
    select 1 from subscription_version_allowances
    where version_id = (v_res->>'version_id')::uuid and tier = 'group' and weekly_limit = 100000
  ) then
    raise exception 'T5b FAILED: unlimited did not force sentinel on all tiers';
  end if;
  raise notice 'T5 PASSED: unlimited allowance sentinel applied';

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
