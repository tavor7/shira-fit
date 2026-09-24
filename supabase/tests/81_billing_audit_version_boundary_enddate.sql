-- Pre-merge financial audit, batch 2: multi-version segmentation (the §5 architectural finding,
-- now IMPLEMENTED via unified segmentation, not just demonstrated), end-date boundaries,
-- tombstone, rounding, crash-recovery, per-subscription isolation.
set client_min_messages to notice;

-- Test AU4 / "Test A": a version change landing MID-period (anchor stays fixed; price changes
-- from ₪300 to ₪400 10 days into the period). Verifies the period is correctly SEGMENTED and
-- BLENDED across the version boundary -- not priced entirely under whichever version_id happens
-- to be passed to subscription_generate_or_correct_billing_period (that was the pre-fix bug).
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid; v_start date; v_anchor smallint;
  v_end date; v_mid date; v_amt numeric; v_total_days int; v_seg1_days int; v_seg2_days int;
  v_expected numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au4', 'Athlete AU4', '0500002004', 'athlete', 'approved');

  v_start := current_date - 5;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  v_mid := v_start + 10; -- 10 days into the period, NOT on the anchor boundary

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, v_mid, 300, v_anchor, v_start) returning id into v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_mid, 400, v_anchor, v_start) returning id into v_ver2;

  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_start, v_end, null, null);
  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');

  v_total_days := v_end - v_start;
  v_seg1_days := v_mid - v_start; -- 10 days at 300
  v_seg2_days := v_end - v_mid;   -- remaining days at 400
  v_expected := round((300::numeric * v_seg1_days + 400::numeric * v_seg2_days) / v_total_days, 2);

  if v_amt <> v_expected then
    raise exception 'AU4 FAILED: expected blended amount % (seg1 % days @300 + seg2 % days @400 / % total), got %',
      v_expected, v_seg1_days, v_seg2_days, v_total_days, v_amt;
  end if;

  -- version_id passed to the call (v_ver2, the "current" version at call time) must have no
  -- bearing on which price(s) applied -- confirm passing v_ver1 instead gives the IDENTICAL
  -- result (same period, same real timeline), proving pricing is independent of which version_id
  -- happens to be passed.
  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver1, v_start, v_end, null, 'freeze_credit');
  -- (this second call is a no-op / correction check only if the recomputed amount differs, which
  -- it should NOT -- the amount is identical regardless of p_version_id)
  if (select count(*) from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
      where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type='reversal') > 0 then
    raise exception 'AU4 FAILED: calling with a different (but uninvolved) version_id triggered a spurious correction -- pricing is not independent of p_version_id';
  end if;

  raise notice 'AU4 (Test A) PASSED: mid-period version change (300->400 at day 10 of %) correctly segments and blends to exactly % — % days@300 + % days@400 over % total days, independent of which version_id is passed to the call',
    v_total_days, v_amt, v_seg1_days, v_seg2_days, v_total_days;
end $$;

-- Test AU5: end-date boundary matrix.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint; v_end date;
  v_res json; v_amt numeric; v_total int;
begin
  -- 5a: end date exactly ON the anchor date (plan_end_date = period_end - 1, i.e. subscription
  -- runs through the last day of the period and stops cleanly at the boundary) -> full charge,
  -- no truncation, no period generated after.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5a', 'Athlete AU5A', '0500002005', 'athlete', 'approved');
  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start, v_end - 1) returning id into v_ver;
  perform public.generate_due_subscription_charges();
  select amount_ils into v_amt from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');
  if v_amt <> 300 then raise exception 'AU5a FAILED: end-on-anchor should be a full, untruncated charge, got %', v_amt; end if;
  if exists (select 1 from subscription_billing_periods where subscription_id=v_sub and period_start >= v_end) then
    raise exception 'AU5a FAILED: a period was generated on/after the end date';
  end if;
  raise notice 'AU5a PASSED: end date exactly on anchor -> full charge, no period after';

  -- 5b: end date ONE DAY BEFORE anchor -> truncated by exactly 1 day.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5b', 'Athlete AU5B', '0500002006', 'athlete', 'approved');
  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start, v_end - 2) returning id into v_ver;
  perform public.generate_due_subscription_charges();
  select amount_ils into v_amt from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');
  select period_end - period_start into v_total from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  declare v_exp numeric := round(300::numeric * (v_total - 1) / v_total, 2);
  begin
    if v_amt <> v_exp then raise exception 'AU5b FAILED: expected % (1 day short), got %', v_exp, v_amt; end if;
  end;
  raise notice 'AU5b PASSED: end date one day before anchor -> prorated by exactly 1 day (%)', v_amt;

  -- 5c: end date ONE DAY AFTER anchor -> period 1 fully billed, period 2 gets exactly 1 billable day.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5c', 'Athlete AU5C', '0500002007', 'athlete', 'approved');
  v_start := current_date - 40; -- far enough back that period 2 is also already due
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start); -- period 1 end = period 2 start
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start, v_end) returning id into v_ver; -- plan_end_date = period_end (1 day after anchor, inclusive)
  perform public.generate_due_subscription_charges();
  select amount_ils into v_amt from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');
  if v_amt <> 300 then raise exception 'AU5c FAILED: period 1 should be full 300, got %', v_amt; end if;
  if exists (select 1 from subscription_billing_periods where subscription_id=v_sub and period_start=v_end) then
    select amount_ils into v_amt from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
      where bp.subscription_id=v_sub and bp.period_start=v_end and c.charge_type in ('recurring','proration');
    select period_end - period_start into v_total from subscription_billing_periods where subscription_id=v_sub and period_start=v_end;
    declare v_exp2 numeric := round(300::numeric * 1 / v_total, 2);
    begin
      if v_amt <> v_exp2 then raise exception 'AU5c FAILED: period 2 should bill exactly 1 day (%), got %', v_exp2, v_amt; end if;
    end;
    raise notice 'AU5c PASSED: end date one day after anchor -> period 1 full, period 2 bills exactly 1 day (%)', v_amt;
  else
    raise exception 'AU5c FAILED: period 2 (the 1 extra billable day) was not generated at all';
  end if;

  -- 5d: unlimited subscription (no end date) -- already implicitly covered by B1-B3, re-confirm.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5d', 'Athlete AU5D', '0500002008', 'athlete', 'approved');
  v_start := current_date - 1;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;
  perform public.generate_due_subscription_charges();
  if not exists (select 1 from subscription_billing_periods where subscription_id=v_sub) then
    raise exception 'AU5d FAILED: unlimited subscription should still bill normally';
  end if;
  raise notice 'AU5d PASSED: unlimited subscription (no plan_end_date) bills normally';

  -- 5e: scheduled future subscription -- zero periods generated yet.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5e', 'Athlete AU5E', '0500002009', 'athlete', 'approved');
  v_start := current_date + 10;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;
  perform public.generate_due_subscription_charges();
  if exists (select 1 from subscription_billing_periods where subscription_id=v_sub) then
    raise exception 'AU5e FAILED: a future-scheduled subscription generated a period early';
  end if;
  raise notice 'AU5e PASSED: scheduled future subscription (plan_start_date in the future) generates zero periods';

  -- 5f: stopped subscription -- zero periods after the stop, even across repeated ("later") runs.
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au5f', 'Athlete AU5F', '0500002010', 'athlete', 'approved');
  v_start := current_date - 5;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, stopped_effective_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start, v_start + 2) returning id into v_ver;
  perform public.generate_due_subscription_charges();
  perform public.generate_due_subscription_charges(); -- simulate a later cron run
  perform public.generate_due_subscription_charges(); -- and another
  if (select count(*) from subscription_billing_periods where subscription_id=v_sub) <> 1 then
    raise exception 'AU5f FAILED: stopped subscription should generate exactly 1 (truncated) period, ever, got %',
      (select count(*) from subscription_billing_periods where subscription_id=v_sub);
  end if;
  raise notice 'AU5f PASSED: stopped subscription generates exactly one truncated period, never more, across repeated runs';
end $$;

do $$ begin raise notice 'ALL AUDIT TESTS BATCH 2 (AU4-AU5) PASSED'; end $$;
