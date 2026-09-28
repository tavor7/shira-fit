-- Phase 3 billing-engine tests, batch 2: freeze (PAUSE semantics, corrected), stop, idempotency.
--
-- B5-B7 rewritten for the freeze-as-pause correction (see 20260929100000_subscriptions_freeze_
-- pause_semantics.sql): a freeze no longer discounts a fixed-boundary period -- it EXTENDS the
-- period's effective end by the freeze's own duration and excludes the frozen span from both
-- sides of the proration ratio, so a period containing only a freeze (no other proration reason)
-- nets to the SAME full price as an unfrozen period, just realized over a longer real-calendar
-- span. B8 (stop, no freeze involved) is unchanged.
set client_min_messages to notice;

-- Test B5: partial freeze entirely inside one period -> period extended by the freeze duration,
-- still charges full price (a pause, not a discount).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_bp_id uuid; v_amt numeric; v_type public.subscription_charge_type;
  v_freeze_from date; v_freeze_until date; v_raw_end date; v_eff_start date; v_eff_end date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b5', 'Athlete B5', '0500001005', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  v_freeze_from := v_start + 5;
  v_freeze_until := v_start + 14; -- 10 days inclusive
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_freeze_from, v_freeze_until);

  v_raw_end := public.subscription_next_anchor_date(extract(day from v_start)::int::smallint, v_start);
  v_eff_start := v_start + 10;
  v_eff_end := v_raw_end + 10;

  perform public.generate_due_subscription_charges();

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and raw_period_start=v_start;
  if v_bp_id is null then raise exception 'B5 FAILED: no billing period generated'; end if;

  select period_start, period_end into v_eff_start, v_eff_end from subscription_billing_periods where id=v_bp_id;
  if v_eff_start <> v_start + 10 or v_eff_end <> v_raw_end + 10 then
    raise exception 'B5 FAILED: expected effective window %..% (raw + 10 frozen days), got %..%',
      v_start + 10, v_raw_end + 10, v_eff_start, v_eff_end;
  end if;

  select amount_ils, charge_type into v_amt, v_type from subscription_charges
  where billing_period_id=v_bp_id and charge_type in ('recurring','proration');
  if v_amt <> 300 then
    raise exception 'B5 FAILED: a 10-day freeze fully inside the period should still charge the full ₪300 (pause, not discount), got %', v_amt;
  end if;

  raise notice 'B5 PASSED: partial in-period freeze extends the period by 10 days and still charges full ₪300 (type=%)', v_type;
end $$;

-- Test B6: freeze covering the entire first period (and beyond) from day 1 -> the period is not
-- due yet in real time (its effective start is still in the future), so NOTHING is generated.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_count int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b6', 'Athlete B6', '0500001006', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  v_end := public.subscription_next_anchor_date(extract(day from v_start)::int::smallint, v_start);
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start, v_end + 5);

  perform public.generate_due_subscription_charges();

  select count(*) into v_bp_count from subscription_billing_periods where subscription_id=v_sub;
  if v_bp_count <> 0 then
    raise exception 'B6 FAILED: a period frozen from its own raw start should not be due yet (effective start still in the future) -- expected 0 rows, got %', v_bp_count;
  end if;

  -- Re-run: still nothing generated (idempotent "not due yet").
  perform public.generate_due_subscription_charges();
  select count(*) into v_bp_count from subscription_billing_periods where subscription_id=v_sub;
  if v_bp_count <> 0 then raise exception 'B6 FAILED: re-run unexpectedly generated a period'; end if;

  raise notice 'B6 PASSED: freeze covering a period from its own start correctly delays it -- not yet due, nothing generated';
end $$;

-- Test B7: freeze spanning from mid-period-1 to mid-period-2 -> both periods shift by the FULL
-- cumulative freeze duration, contiguous, each still priced at full recurring price.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint;
  v_freeze_from date; v_freeze_until date; v_freeze_days int;
  r record; v_prev_end date; v_count int := 0;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b7', 'Athlete B7', '0500001007', 'athlete', 'approved');

  v_start := current_date - 80;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver;

  v_freeze_from := v_start + 20;
  v_freeze_until := v_start + 64;
  v_freeze_days := v_freeze_until - v_freeze_from + 1; -- 45
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_freeze_from, v_freeze_until);

  perform public.generate_due_subscription_charges();

  for r in
    select bp.raw_period_start, bp.period_start, bp.period_end, bp.frozen_days_applied, c.amount_ils, c.charge_type
    from subscription_billing_periods bp
    join subscription_charges c on c.billing_period_id = bp.id and c.charge_type in ('recurring','proration')
    where bp.subscription_id = v_sub
    order by bp.raw_period_start
  loop
    v_count := v_count + 1;
    if r.frozen_days_applied <> v_freeze_days then
      raise exception 'B7 FAILED: period % expected frozen_days_applied=%, got %', r.raw_period_start, v_freeze_days, r.frozen_days_applied;
    end if;
    if r.amount_ils <> 300 then
      raise exception 'B7 FAILED: period % expected full ₪300 (pause nets to no discount), got %', r.raw_period_start, r.amount_ils;
    end if;
    if v_prev_end is not null and r.period_start <> v_prev_end then
      raise exception 'B7 FAILED: periods are not contiguous after shifting (% <> %)', r.period_start, v_prev_end;
    end if;
    v_prev_end := r.period_end;
  end loop;

  if v_count < 2 then
    raise exception 'B7 FAILED: expected at least 2 billing periods to have been generated by now, got %', v_count;
  end if;

  raise notice 'B7 PASSED: multi-period freeze shifts every touched period by the full % cumulative days, contiguous, full price each', v_freeze_days;
end $$;

-- Test B8: stop mid-period -> correct proration, no periods generated after the stop. Unaffected
-- by the freeze correction (no freeze involved).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint;
  v_stop date; v_bp_id uuid; v_amt numeric; v_total int; v_exp numeric;
  v_periods_after int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b8', 'Athlete B8', '0500001008', 'athlete', 'approved');

  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver;

  v_stop := v_start + 8;
  update subscription_versions set stopped_effective_date = v_stop where id = v_ver;

  perform public.generate_due_subscription_charges();

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  if v_bp_id is null then raise exception 'B8 FAILED: no billing period created for the (truncated) first period'; end if;

  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;
  v_exp := round(300::numeric * 8 / v_total, 2);

  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp_id and charge_type='proration';
  if v_amt <> v_exp then raise exception 'B8 FAILED: expected % (8 of % days), got %', v_exp, v_total, v_amt; end if;

  select count(*) into v_periods_after from subscription_billing_periods
  where subscription_id = v_sub and period_start >= v_stop;
  if v_periods_after > 0 then raise exception 'B8 FAILED: a period was generated on/after the stop date'; end if;

  raise notice 'B8 PASSED: stop mid-period prorates to % of % days, nothing generated after the stop', v_amt, v_total;
end $$;

do $$ begin raise notice 'ALL BILLING TESTS BATCH 2 (B5-B8) PASSED'; end $$;
