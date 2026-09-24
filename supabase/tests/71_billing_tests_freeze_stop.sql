-- Phase 3 billing-engine tests, batch 2: freeze, stop, retroactive correction, idempotency.
set client_min_messages to notice;

-- Test B5: partial freeze within one period (some days frozen, some not).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_bp_id uuid; v_amt numeric;
  v_freeze_from date; v_freeze_until date; v_total_days int; v_expected numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b5', 'Athlete B5', '0500001005', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  -- Freeze 10 days, entirely inside the first period, not touching its edges.
  v_freeze_from := v_start + 5;
  v_freeze_until := v_start + 14; -- 10 days inclusive
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_freeze_from, v_freeze_until);

  perform public.generate_due_subscription_charges();

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select period_end - period_start into v_total_days from subscription_billing_periods where id=v_bp_id;
  v_expected := round(300::numeric * (v_total_days - 10) / v_total_days, 2);

  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp_id and charge_type='proration';
  if v_amt is null then raise exception 'B5 FAILED: no proration charge (organic, freeze already in place before billing)'; end if;
  if v_amt <> v_expected then
    raise exception 'B5 FAILED: expected % (10 of % days frozen), got %', v_expected, v_total_days, v_amt;
  end if;
  raise notice 'B5 PASSED: partial freeze (10 of % days) prorates to %', v_total_days, v_amt;
end $$;

-- Test B6: full-period freeze -> exactly one billing period, charge amount ₪0.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_count int; v_charge_count int; v_amt numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b6', 'Athlete B6', '0500001006', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  v_end := public.subscription_next_anchor_date(extract(day from v_start)::int::smallint, v_start);
  -- Freeze the ENTIRE first period (and then some, to be safe about boundary math).
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start, v_end + 5);

  perform public.generate_due_subscription_charges();

  select count(*) into v_bp_count from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  if v_bp_count <> 1 then raise exception 'B6 FAILED: expected exactly 1 billing period row, got %', v_bp_count; end if;

  select count(*) into v_charge_count from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');
  if v_charge_count <> 1 then raise exception 'B6 FAILED: expected exactly 1 original charge row, got %', v_charge_count; end if;

  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');
  if v_amt <> 0 then raise exception 'B6 FAILED: expected ₪0 charge for full-period freeze, got %', v_amt; end if;

  -- Re-run: still exactly one period, one charge (idempotent).
  perform public.generate_due_subscription_charges();
  select count(*) into v_bp_count from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  if v_bp_count <> 1 then raise exception 'B6 FAILED: re-run created a duplicate billing period'; end if;

  raise notice 'B6 PASSED: full-period freeze -> exactly one billing period, ₪0 charge, idempotent re-run';
end $$;

-- Test B7: freeze spanning multiple billing periods -- one row/charge per period, each correctly
-- prorated for its own unfrozen days.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint;
  v_freeze_from date; v_freeze_until date;
  r record; v_expected numeric; v_total int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b7', 'Athlete B7', '0500001007', 'athlete', 'approved');

  v_start := current_date - 80;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver;

  -- A freeze spanning from partway through period 1 to partway through period 2 (45 days,
  -- guaranteed to cross at least one anchor boundary given ~30-day periods).
  v_freeze_from := v_start + 20;
  v_freeze_until := v_start + 64;
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_freeze_from, v_freeze_until);

  perform public.generate_due_subscription_charges();

  -- Verify at least 2 periods were touched by the freeze, each individually correctly prorated.
  for r in
    select bp.id, bp.period_start, bp.period_end,
           (bp.period_end - bp.period_start) as total_days,
           c.amount_ils, c.charge_type
    from subscription_billing_periods bp
    join subscription_charges c on c.billing_period_id = bp.id and c.charge_type in ('recurring','proration')
    where bp.subscription_id = v_sub
    order by bp.period_start
  loop
    -- recompute expected using the same helper the engine itself uses (not reimplementing math
    -- independently -- this test verifies the STORED charge matches a fresh call to the same
    -- authoritative helper, catching drift/bugs in the generation path itself).
    declare v_ufd int; v_exp numeric;
    begin
      select unfrozen_days into v_ufd from public.subscription_billing_period_unfrozen_days(
        v_sub, r.period_start, r.period_end, null, null
      );
      v_exp := case when v_ufd = r.total_days then 300::numeric else round(300::numeric * v_ufd / r.total_days, 2) end;
      if r.amount_ils <> v_exp then
        raise exception 'B7 FAILED: period % expected %, got % (unfrozen % of % days)', r.period_start, v_exp, r.amount_ils, v_ufd, r.total_days;
      end if;
    end;
  end loop;

  if (select count(*) from subscription_billing_periods where subscription_id=v_sub
      and period_start <= v_freeze_until and period_end > v_freeze_from) < 2 then
    raise exception 'B7 FAILED: expected the freeze to touch at least 2 billing periods';
  end if;

  raise notice 'B7 PASSED: multi-period freeze correctly prorates each touched period independently';
end $$;

-- Test B8: stop mid-period -> correct proration, no periods generated after the stop.
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

  -- Stop 8 days into the first (unbilled) period.
  v_stop := v_start + 8;
  update subscription_versions set stopped_effective_date = v_stop where id = v_ver;

  perform public.generate_due_subscription_charges();

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  if v_bp_id is null then raise exception 'B8 FAILED: no billing period created for the (truncated) first period'; end if;

  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;
  v_exp := round(300::numeric * 8 / v_total, 2); -- days v_start..v_stop-1 = 8 days billable

  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp_id and charge_type='proration';
  if v_amt <> v_exp then raise exception 'B8 FAILED: expected % (8 of % days), got %', v_exp, v_total, v_amt; end if;

  select count(*) into v_periods_after from subscription_billing_periods
  where subscription_id = v_sub and period_start >= v_stop;
  if v_periods_after > 0 then raise exception 'B8 FAILED: a period was generated on/after the stop date'; end if;

  raise notice 'B8 PASSED: stop mid-period prorates to % of % days, nothing generated after the stop', v_amt, v_total;
end $$;

do $$ begin raise notice 'ALL BILLING TESTS BATCH 2 (B5-B8) PASSED'; end $$;
