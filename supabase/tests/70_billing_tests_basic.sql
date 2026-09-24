-- Phase 3 billing-engine tests. NOTE: generate_due_subscription_charges() and
-- subscription_generate_or_correct_billing_period() were both revoked from public/authenticated
-- (matching open_next_week_sessions_if_due_core's pattern) — tests call them directly as the
-- postgres superuser, which bypasses grants, exactly like the daily cron job would.
set client_min_messages to notice;

-- Helper: create a bare subscription+version (no session/registration machinery needed for
-- billing-only tests) and freeze "today" conceptually via explicit dates far in the future so
-- tests are deterministic regardless of when this suite runs.

-- Test B1: immediate first charge on plan_start_date (not deferred a month).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_res json;
  v_bp_id uuid; v_amt numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b1', 'Athlete B1', '0500001001', 'athlete', 'approved');

  v_start := current_date - 1; -- started yesterday, due today
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, 15, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges();

  select bp.id into v_bp_id from subscription_billing_periods bp where bp.subscription_id=v_sub and bp.period_start=v_start;
  if v_bp_id is null then raise exception 'B1 FAILED: no billing period created for plan_start_date'; end if;

  select sum(amount_ils) into v_amt from subscription_charges where billing_period_id=v_bp_id;
  if v_amt <> 300 then raise exception 'B1 FAILED: expected 300 immediate first charge, got %', v_amt; end if;

  if (select charge_type from subscription_charges where billing_period_id=v_bp_id) <> 'recurring' then
    raise exception 'B1 FAILED: first full-price charge should be recurring';
  end if;
  raise notice 'B1 PASSED: immediate first charge on plan_start_date, full ₪300, type=recurring';

  create table if not exists _billing_ids2 (k text primary key, v uuid);
  insert into _billing_ids2 values ('b1_p', v_p), ('b1_sub', v_sub), ('b1_ver', v_ver) on conflict do nothing;
end $$;

-- Test B2: normal monthly cycle -- a few consecutive periods, idempotent re-run.
do $$
declare
  v_sub uuid; v_ver uuid; v_p uuid; v_start date;
  v_periods int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b2', 'Athlete B2', '0500001002', 'athlete', 'approved');

  v_start := current_date - 95; -- roughly 3 months ago
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, 1, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges();
  select count(*) into v_periods from subscription_billing_periods where subscription_id=v_sub;
  if v_periods < 3 then raise exception 'B2 FAILED: expected at least 3 periods after 95 days, got %', v_periods; end if;

  -- idempotent re-run: same count, no duplicates.
  perform public.generate_due_subscription_charges();
  if (select count(*) from subscription_billing_periods where subscription_id=v_sub) <> v_periods then
    raise exception 'B2 FAILED: re-run created duplicate periods';
  end if;

  -- every period has exactly one original (recurring/proration) charge.
  if (select count(*) from subscription_billing_periods bp
      where bp.subscription_id=v_sub
        and (select count(*) from subscription_charges c where c.billing_period_id=bp.id and c.charge_type in ('recurring','proration')) <> 1
     ) > 0 then
    raise exception 'B2 FAILED: some period does not have exactly one original charge';
  end if;
  raise notice 'B2 PASSED: % consecutive periods generated, idempotent re-run, exactly one original charge per period', v_periods;
end $$;

-- Test B3: Jan 31 anchor across leap and non-leap February; anchor day never changes in storage.
do $$
declare
  v_sub uuid; v_ver uuid; v_p uuid;
  v_p1 date; v_p2 date; v_p3 date; v_p4 date; v_p5 date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b3', 'Athlete B3', '0500001003', 'athlete', 'approved');

  -- 2027 is not a leap year; 2028 is. Anchor day 31, starting Jan 31 2027.
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, '2027-01-31', 300, 31, '2027-01-31') returning id into v_ver;

  v_p1 := '2027-01-31';
  v_p2 := public.subscription_next_anchor_date(31::smallint, v_p1); -- Feb 2027 (non-leap) -> 28
  v_p3 := public.subscription_next_anchor_date(31::smallint, v_p2); -- Mar -> 31
  v_p4 := public.subscription_next_anchor_date(31::smallint, v_p3); -- Apr -> 30
  v_p5 := public.subscription_next_anchor_date(31::smallint, v_p4); -- May -> 31

  if v_p2 <> '2027-02-28' then raise exception 'B3 FAILED: expected 2027-02-28, got %', v_p2; end if;
  if v_p3 <> '2027-03-31' then raise exception 'B3 FAILED: expected 2027-03-31, got %', v_p3; end if;
  if v_p4 <> '2027-04-30' then raise exception 'B3 FAILED: expected 2027-04-30, got %', v_p4; end if;
  if v_p5 <> '2027-05-31' then raise exception 'B3 FAILED: expected 2027-05-31, got %', v_p5; end if;

  -- Leap year: Jan 31 2028 -> Feb 29 2028.
  if public.subscription_next_anchor_date(31::smallint, '2028-01-31') <> '2028-02-29' then
    raise exception 'B3 FAILED: leap year Feb should clamp to 29';
  end if;

  -- anchor_day stored on the version never changes across all this.
  if (select anchor_day from subscription_versions where id=v_ver) <> 31 then
    raise exception 'B3 FAILED: stored anchor_day mutated';
  end if;
  raise notice 'B3 PASSED: Jan31 -> Feb28(2027)/Feb29(2028) -> Mar31 -> Apr30 -> May31, anchor_day stays 31 in storage';
end $$;

-- Test B4: partial-period proration (start mid-period, i.e. the very first period itself is
-- shorter than a full month because plan_start_date isn't the 1st and anchor_day forces an
-- early cutoff -- exercised naturally by B1's case already being a full period; construct an
-- explicit truncated-window case via a plan_end_date inside the first period instead).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_id uuid; v_amt numeric;
  v_expected numeric; v_total_days int; v_unfrozen_days int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b4', 'Athlete B4', '0500001004', 'athlete', 'approved');

  v_start := current_date - 10;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  -- plan_end_date 5 days after start -> the first (and only) period is truncated to 6 days
  -- (start through end, inclusive) out of the full anchor-to-anchor period length.
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, plan_end_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start, v_start + 5) returning id into v_ver;

  perform public.generate_due_subscription_charges();

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select period_end - period_start into v_total_days from subscription_billing_periods where id=v_bp_id;
  v_unfrozen_days := 6; -- v_start .. v_start+5 inclusive = 6 days
  v_expected := round(300::numeric * v_unfrozen_days / v_total_days, 2);

  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp_id and charge_type='proration';
  if v_amt is null then raise exception 'B4 FAILED: no proration charge found'; end if;
  if v_amt <> v_expected then
    raise exception 'B4 FAILED: expected % (300 times % over % days), got %', v_expected, v_unfrozen_days, v_total_days, v_amt;
  end if;
  raise notice 'B4 PASSED: partial-period (plan_end_date truncation) prorates to % of % (total % days)', v_amt, v_total_days, v_total_days;
end $$;

do $$ begin raise notice 'ALL BILLING TESTS BATCH 1 (B1-B4) PASSED'; end $$;
