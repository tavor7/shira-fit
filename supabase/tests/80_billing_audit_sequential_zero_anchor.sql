-- Pre-merge financial-correctness audit: sequential corrections, zero-then-corrected periods,
-- on-anchor price cutover, end-date boundaries, tombstone, rounding, crash-recovery.
set client_min_messages to notice;

-- Test AU1: SEQUENTIAL corrections to the SAME period. ₪300 -> freeze -> ₪250 -> a further
-- freeze change -> ₪180. Final net must be exactly ₪180, not 230/-70/430/etc.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_id uuid;
  v_freeze1 uuid; v_freeze2 uuid; v_res json; v_total int; v_net numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_au1', 'Athlete AU1', '0500002001', 'athlete', 'approved');

  v_start := current_date - 20;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges(); -- bills full ₪300
  select id, period_end into v_bp_id, v_end from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;

  -- First freeze: correct to ₪250 (i.e. unfrozen_days = round-trip such that 300*u/total=250).
  -- Use a freeze length that gives an exact ₪250 for a 30-day period: 300*25/30=250 -> 5 frozen days.
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 1, v_start + 5) returning id into v_freeze1; -- 5 days frozen

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver, v_start, v_end, v_freeze1, 'freeze_credit');
  if v_res->>'action' <> 'corrected' then raise exception 'AU1 FAILED: first correction did not apply: %', v_res; end if;
  if (v_res->>'amount_ils')::numeric <> 250.00 then raise exception 'AU1 FAILED: expected first correction to 250, got %', v_res; end if;

  -- Second, LATER, independent correction event: an ADJOINING freeze covering 7 more days
  -- (start+6..start+12), bringing the total frozen days to 12 -> 300*18/30 = 180.
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 6, v_start + 12) returning id into v_freeze2;

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver, v_start, v_end, v_freeze2, 'freeze_credit');
  if v_res->>'action' <> 'corrected' then raise exception 'AU1 FAILED: second correction did not apply: %', v_res; end if;
  if (v_res->>'amount_ils')::numeric <> 180.00 then raise exception 'AU1 FAILED: expected second correction to 180, got %', v_res; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> 180.00 then
    raise exception 'AU1 FAILED: final net must be exactly 180.00, got % (this is the naively-reverse-only-the-original bug if wrong)', v_net;
  end if;

  -- Also verify exactly 2 reversals and 2 corrections exist (one pair per correction event), and
  -- the SECOND reversal points at the FIRST correction's charge (not the original ₪300 charge).
  declare v_rev_count int; v_second_reversal record; v_first_correction_id uuid;
  begin
    select count(*) into v_rev_count from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal';
    if v_rev_count <> 2 then raise exception 'AU1 FAILED: expected exactly 2 reversals, got %', v_rev_count; end if;

    select id into v_first_correction_id from subscription_charges
    where billing_period_id=v_bp_id and charge_type='freeze_credit' and source_event_id=v_freeze1;

    select * into v_second_reversal from subscription_charges
    where billing_period_id=v_bp_id and charge_type='reversal' and source_event_id=v_freeze2;

    if v_second_reversal.reverses <> v_first_correction_id then
      raise exception 'AU1 FAILED: second reversal should point at the FIRST correction (%), points at %', v_first_correction_id, v_second_reversal.reverses;
    end if;
    if v_second_reversal.amount_ils <> -250.00 then
      raise exception 'AU1 FAILED: second reversal should be -250.00 (reversing the currently-effective 250, not the original 300), got %', v_second_reversal.amount_ils;
    end if;
  end;

  raise notice 'AU1 PASSED: sequential corrections 300 -> 250 -> 180, final net exactly 180.00, each reversal targets the currently-effective prior charge';
end $$;

-- Test AU2: zero-charge (full freeze) period, then freeze shortened retroactively -> correct
-- positive charge exactly once (not stacked on stale zero-state, not duplicated).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_end date; v_bp_id uuid;
  v_freeze_id uuid; v_res json; v_total int; v_net numeric; v_charge_count int;
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
  values (v_sub, v_start, v_end + 5) returning id into v_freeze_id; -- freezes the whole period

  perform public.generate_due_subscription_charges();
  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;

  if (select amount_ils from subscription_charges where billing_period_id=v_bp_id and charge_type='proration') <> 0 then
    raise exception 'AU2 FAILED: fresh full-freeze charge should be exactly 0';
  end if;

  -- Retroactively shorten the freeze to only 5 days (freed the rest of the period).
  update public.subscription_freezes set freeze_until = v_start + 4 where id = v_freeze_id;

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver, v_start, v_end, v_freeze_id, 'freeze_credit');
  if v_res->>'action' <> 'corrected' then raise exception 'AU2 FAILED: shortened-freeze correction did not apply: %', v_res; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  declare v_exp numeric := round(300::numeric * (v_total - 5) / v_total, 2);
  begin
    if v_net <> v_exp then raise exception 'AU2 FAILED: expected net %, got %', v_exp, v_net; end if;
  end;

  select count(*) into v_charge_count from subscription_charges c
    join subscription_billing_periods bp on bp.id = c.billing_period_id
    where bp.subscription_id = v_sub and c.charge_type not in ('reversal');
  if v_charge_count <> 2 then -- original (0) + freeze_credit (positive), exactly once each
    raise exception 'AU2 FAILED: expected exactly 2 non-reversal charges (original + one correction), got %', v_charge_count;
  end if;

  raise notice 'AU2 PASSED: full-freeze (₪0) -> retroactively shortened -> correct positive charge exactly once, net %', v_net;
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
