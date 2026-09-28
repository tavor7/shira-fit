-- Pre-merge financial-correctness audit: sequential corrections, zero-then-corrected periods,
-- on-anchor price cutover, end-date boundaries, tombstone, rounding, crash-recovery.
set client_min_messages to notice;

-- Test AU1 (rewritten for the pause correction): SEQUENTIAL freezes on the SAME already-billed
-- period must compound cumulatively (not double-count, not reset), and each one remains a pure
-- pause -- zero reversals, the charge stays exactly ₪300 throughout, only the effective window
-- keeps extending by each freeze's own duration on top of the running total.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_raw_end date; v_bp_id uuid;
  v_freeze1 uuid; v_freeze2 uuid; v_res json; v_period_start date; v_period_end date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au1', 'Athlete AU1', '0500002001', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges(); -- bills full ₪300
  select id, raw_period_end into v_bp_id, v_raw_end from subscription_billing_periods where subscription_id=v_sub and raw_period_start=v_start;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 1, v_start + 5) returning id into v_freeze1; -- 5 days

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver, v_start, v_raw_end, v_freeze1, 'freeze_credit');
  if v_res->>'action' <> 'unchanged' or (v_res->>'amount_ils')::numeric <> 300.00 then
    raise exception 'AU1 FAILED: first freeze correction must be a pure pause (unchanged, ₪300), got %', v_res;
  end if;
  select period_start, period_end into v_period_start, v_period_end from subscription_billing_periods where id=v_bp_id;
  if v_period_start <> v_start + 5 then raise exception 'AU1 FAILED: expected period_start shifted by 5, got %', v_period_start; end if;

  -- Second, LATER, adjoining freeze (7 more days) -- must compound to the FULL cumulative 12,
  -- recomputed fresh from subscription_total_frozen_days, never additively re-applied on top of
  -- the already-shifted dates (which would double-count).
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 6, v_start + 12) returning id into v_freeze2;

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver, v_start, v_raw_end, v_freeze2, 'freeze_credit');
  if v_res->>'action' <> 'unchanged' or (v_res->>'amount_ils')::numeric <> 300.00 then
    raise exception 'AU1 FAILED: second freeze correction must also be a pure pause (unchanged, ₪300), got %', v_res;
  end if;
  select period_start, period_end into v_period_start, v_period_end from subscription_billing_periods where id=v_bp_id;
  if v_period_start <> v_start + 12 then
    raise exception 'AU1 FAILED: expected period_start shifted by the FULL cumulative 12 days (%), got % -- double-shift or reset bug', v_start + 12, v_period_start;
  end if;

  if exists (select 1 from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal') then
    raise exception 'AU1 FAILED: sequential pure-pause freezes must never produce a reversal';
  end if;
  if (select sum(amount_ils) from subscription_charges where billing_period_id=v_bp_id) <> 300.00 then
    raise exception 'AU1 FAILED: net must remain exactly 300.00 after both freezes';
  end if;

  raise notice 'AU1 PASSED: two sequential freezes (5 + 7 days) compound to a cumulative 12-day shift, net stays exactly 300.00, zero reversals';
end $$;

-- Test AU2 (rewritten for the pause correction): a period frozen from its own raw start is simply
-- NOT DUE YET (0 rows) -- then the freeze is shortened retroactively, which pulls the effective
-- start back into the past, making the period due; it must then bill cleanly at full price exactly
-- once (not "corrected" from a stale ₪0, since it was never billed in the first place).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_id uuid;
  v_freeze_id uuid; v_cnt int; v_amt numeric; v_type public.subscription_charge_type;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au2', 'Athlete AU2', '0500002002', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  select public.subscription_next_anchor_date(extract(day from v_start)::int::smallint, v_start) into v_end;
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start, v_end + 5) returning id into v_freeze_id; -- freezes the whole raw period + more

  perform public.generate_due_subscription_charges();
  select count(*) into v_cnt from subscription_billing_periods where subscription_id=v_sub;
  if v_cnt <> 0 then raise exception 'AU2 FAILED: fully-frozen-from-start period should not be due yet, got % rows', v_cnt; end if;

  -- Retroactively shorten the freeze to only 5 days (frees up the rest of the period).
  update public.subscription_freezes set freeze_until = v_start + 4 where id = v_freeze_id;

  perform public.generate_due_subscription_charges();
  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and raw_period_start=v_start;
  if v_bp_id is null then raise exception 'AU2 FAILED: shortening the freeze should have made the period due -- none generated'; end if;

  select amount_ils, charge_type into v_amt, v_type from subscription_charges
  where billing_period_id=v_bp_id and charge_type in ('recurring','proration');
  if v_amt <> 300.00 then raise exception 'AU2 FAILED: expected a clean full ₪300 charge once due, got %', v_amt; end if;
  if exists (select 1 from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal') then
    raise exception 'AU2 FAILED: this period was never billed before -- there must be no reversal, only the fresh charge';
  end if;

  select count(*) into v_cnt from subscription_charges where billing_period_id=v_bp_id and charge_type not in ('reversal');
  if v_cnt <> 1 then raise exception 'AU2 FAILED: expected exactly 1 non-reversal charge, got %', v_cnt; end if;

  raise notice 'AU2 PASSED: fully-frozen-from-start period stayed undue until shortened, then billed cleanly at full ₪300 exactly once (type=%)', v_type;
end $$;

-- Test AU3: price change landing EXACTLY on the anchor date -> clean cutover, anchor unchanged,
-- no proration needed for the new period.
--
-- Calls subscription_generate_or_correct_billing_period directly for each period with its own
-- explicit version_id (rather than going through generate_due_subscription_charges(), whose
-- due-date walk would have already auto-billed period 2 under the OLD version before this test
-- could install the new one, given how far in the past a natural multi-period setup would need
-- to start) -- this isolates exactly the question at hand: does the billing function correctly
-- price a period using the SPECIFIC version passed to it, with a clean on-anchor cutover.
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid; v_start date; v_anchor smallint;
  v_p1_end date; v_p2_end date; v_bp1 uuid; v_bp2 uuid; v_amt numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au3', 'Athlete AU3', '0500002003', 'athlete', 'approved');

  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver1;

  v_p1_end := public.subscription_next_anchor_date(v_anchor, v_start);
  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver1, v_start, v_p1_end, null, null);
  select id into v_bp1 from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp1 and charge_type in ('recurring','proration');
  if v_amt <> 300 then raise exception 'AU3 setup FAILED: period 1 should be 300, got %', v_amt; end if;

  -- Close version 1 exactly at the anchor date (period 1's end = period 2's start); open
  -- version 2 there at the new price -- a clean, on-anchor cutover, no mid-period split needed.
  update public.subscription_versions set effective_to = v_p1_end where id = v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_p1_end, 450, v_anchor, v_start) returning id into v_ver2;

  v_p2_end := public.subscription_next_anchor_date(v_anchor, v_p1_end);
  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_p1_end, v_p2_end, null, null);
  select id into v_bp2 from subscription_billing_periods where subscription_id=v_sub and period_start=v_p1_end;
  if v_bp2 is null then raise exception 'AU3 FAILED: period 2 was not generated'; end if;
  select amount_ils into v_amt from subscription_charges where billing_period_id=v_bp2 and charge_type in ('recurring','proration');
  if v_amt <> 450 then raise exception 'AU3 FAILED: expected clean cutover to new price 450, got %', v_amt; end if;

  -- Anchor day must be unchanged across the cutover.
  if (select anchor_day from subscription_versions where id=v_ver2) <> v_anchor then
    raise exception 'AU3 FAILED: anchor day changed across the version cutover';
  end if;

  raise notice 'AU3 PASSED: on-anchor price cutover (300 -> 450) bills the new period cleanly at the new price, no proration, anchor unchanged';
end $$;

do $$ begin raise notice 'ALL AUDIT TESTS BATCH 1 (AU1-AU3) PASSED'; end $$;
