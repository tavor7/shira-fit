-- Remaining explicit test combinations: version change one day before anchor (near-clean
-- cutover, minimal proration), version change during a full-period freeze (frozen segment
-- contributes ₪0 regardless of which version's price would otherwise apply).
set client_min_messages to notice;

-- Version change one day before the anchor -> the tiny 1-day segment before the boundary still
-- prices correctly and independently from the (much larger) segment after it.
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid;
  v_start date; v_anchor smallint; v_end date; v_cutover date; v_total_days int;
  v_amt numeric; v_expected numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_vc1', 'Athlete VC1', '0500003004', 'athlete', 'approved');

  v_start := current_date - 3;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  v_total_days := v_end - v_start;
  v_cutover := v_end - 1; -- one day before the anchor/period end

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, v_cutover, 300, v_anchor, v_start) returning id into v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_cutover, 999, v_anchor, v_start) returning id into v_ver2;

  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_start, v_end, null, null);
  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');

  v_expected := round((300::numeric * (v_total_days - 1) + 999::numeric * 1) / v_total_days, 2);
  if v_amt <> v_expected then
    raise exception 'VC1 FAILED: expected % (%d days@300 + 1 day@999 / %d), got %', v_expected, v_total_days-1, v_total_days, v_amt;
  end if;
  raise notice 'VC1 PASSED: version change one day before anchor correctly isolates the tiny 1-day segment (%)', v_amt;
end $$;

-- Version change occurring entirely DURING a full-period freeze. Under the pause model, shifting
-- the raw period by the full frozen-day count moves its EFFECTIVE window to land entirely AFTER
-- the freeze ends -- so it is priced normally (full recurring price) under whichever version
-- governs that real, post-freeze calendar range (v_ver2, since the shifted window starts after
-- v_mid). There is no scenario in the pause model where a period charges ₪0 purely from a freeze
-- (a fully-frozen period is instead simply not due yet -- see 71_billing_tests_freeze_stop.sql B6).
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid;
  v_start date; v_anchor smallint; v_end date; v_mid date;
  v_amt numeric; v_bp_count int; v_res json;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_vc2', 'Athlete VC2', '0500003005', 'athlete', 'approved');

  v_start := current_date - 3;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  v_mid := v_start + 15; -- version changes mid-freeze

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, v_mid, 300, v_anchor, v_start) returning id into v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_mid, 999, v_anchor, v_start) returning id into v_ver2;

  -- Freeze the ENTIRE raw period (and beyond), spanning both versions.
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start, v_end + 5);

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_start, v_end, null, null);

  select count(*) into v_bp_count from subscription_billing_periods where subscription_id=v_sub and raw_period_start=v_start;
  if v_bp_count <> 1 then raise exception 'VC2 FAILED: expected exactly 1 billing period row, got %', v_bp_count; end if;

  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.raw_period_start=v_start and c.charge_type in ('recurring','proration');
  if v_amt <> 999 then
    raise exception 'VC2 FAILED: shifted past the freeze, the period should price at v_ver2''s full ₪999, got % (result: %)', v_amt, v_res;
  end if;

  raise notice 'VC2 PASSED: version change during a full-period freeze -> shifted window lands entirely after the freeze, priced at the governing (v_ver2) full price, not a ₪0 in-freeze discount';
end $$;

do $$ begin raise notice 'ALL SEGMENTATION TESTS BATCH 3 (VC1, VC2) PASSED'; end $$;
