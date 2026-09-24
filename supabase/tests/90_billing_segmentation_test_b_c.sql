-- Multi-version segmentation tests required by the architectural-decision pass: Test B (two
-- boundaries / three segments), Test C (price change + freeze interaction), Test D/E (retroactive
-- version change + sequential correction on top of it).
set client_min_messages to notice;

-- Test B: ₪300 -> ₪400 -> ₪350, two version boundaries inside one period. Verify all three
-- segments individually (via the segmentation function directly) and the summed total.
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid; v_ver3 uuid;
  v_start date; v_anchor smallint; v_end date; v_b1 date; v_b2 date;
  v_amt numeric; v_total_days int;
  v_seg1_days int; v_seg2_days int; v_seg3_days int; v_expected numeric;
  r record; v_seg_count int := 0;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b_test', 'Athlete BTest', '0500003001', 'athlete', 'approved');

  v_start := current_date - 3;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  v_total_days := v_end - v_start;
  v_b1 := v_start + 8;  -- first boundary: 300 -> 400
  v_b2 := v_start + 19; -- second boundary: 400 -> 350

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, v_b1, 300, v_anchor, v_start) returning id into v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_b1, v_b2, 400, v_anchor, v_start) returning id into v_ver2;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 3, v_b2, 350, v_anchor, v_start) returning id into v_ver3;

  -- Verify each segment individually via the segmentation function.
  for r in
    select * from public.subscription_billing_period_segments(v_sub, v_start, v_end) order by segment_start
  loop
    v_seg_count := v_seg_count + 1;
    if v_seg_count = 1 then
      if r.segment_start <> v_start or r.segment_end <> v_b1 or r.monthly_price_ils <> 300 or not r.is_billable then
        raise exception 'Test B FAILED: segment 1 wrong: %', r;
      end if;
      v_seg1_days := r.segment_days;
    elsif v_seg_count = 2 then
      if r.segment_start <> v_b1 or r.segment_end <> v_b2 or r.monthly_price_ils <> 400 or not r.is_billable then
        raise exception 'Test B FAILED: segment 2 wrong: %', r;
      end if;
      v_seg2_days := r.segment_days;
    elsif v_seg_count = 3 then
      if r.segment_start <> v_b2 or r.segment_end <> v_end or r.monthly_price_ils <> 350 or not r.is_billable then
        raise exception 'Test B FAILED: segment 3 wrong: %', r;
      end if;
      v_seg3_days := r.segment_days;
    else
      raise exception 'Test B FAILED: more than 3 segments produced: %', r;
    end if;
  end loop;
  if v_seg_count <> 3 then raise exception 'Test B FAILED: expected exactly 3 segments, got %', v_seg_count; end if;

  v_expected := round((300::numeric*v_seg1_days + 400::numeric*v_seg2_days + 350::numeric*v_seg3_days) / v_total_days, 2);

  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver3, v_start, v_end, null, null);
  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');

  if v_amt <> v_expected then
    raise exception 'Test B FAILED: expected sum % (% @300 + % @400 + % @350 over % days), got %',
      v_expected, v_seg1_days, v_seg2_days, v_seg3_days, v_total_days, v_amt;
  end if;

  raise notice 'Test B PASSED: 3 segments (% @300, % @400, % @350 of % total days) verified individually and summed to exactly %',
    v_seg1_days, v_seg2_days, v_seg3_days, v_total_days, v_amt;
end $$;

-- Test C: mid-period price change + a freeze overlapping part of one version's segment. Frozen
-- days contribute ₪0 regardless of which version's price would otherwise apply; non-frozen days
-- in each segment use that segment's correct price.
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid;
  v_start date; v_anchor smallint; v_end date; v_mid date; v_total_days int;
  v_amt numeric; v_expected numeric;
  v_seg1_billable_days int; v_seg2_total_days int; v_seg2_frozen_days int; v_seg2_billable_days int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_c_test', 'Athlete CTest', '0500003002', 'athlete', 'approved');

  v_start := current_date - 3;
  v_anchor := extract(day from v_start)::int::smallint;
  v_end := public.subscription_next_anchor_date(v_anchor, v_start);
  v_total_days := v_end - v_start;
  v_mid := v_start + 10; -- price changes here: 300 -> 400

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, effective_to, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, v_mid, 300, v_anchor, v_start) returning id into v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_mid, 400, v_anchor, v_start) returning id into v_ver2;

  -- Freeze overlapping the SECOND (₪400) segment only: from v_mid+3 to v_mid+8 (6 days frozen,
  -- entirely inside version2's segment, not touching version1's segment at all).
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_mid + 3, v_mid + 8);

  perform public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_start, v_end, null, null);
  select amount_ils into v_amt from subscription_charges c
    join subscription_billing_periods bp on bp.id=c.billing_period_id
    where bp.subscription_id=v_sub and bp.period_start=v_start and c.charge_type in ('recurring','proration');

  v_seg1_billable_days := v_mid - v_start; -- version1 segment, fully billable, unaffected by the freeze
  v_seg2_total_days := v_end - v_mid;
  v_seg2_frozen_days := 6; -- v_mid+3 .. v_mid+8 inclusive = 6 days
  v_seg2_billable_days := v_seg2_total_days - v_seg2_frozen_days;

  v_expected := round(
    (300::numeric * v_seg1_billable_days + 400::numeric * v_seg2_billable_days) / v_total_days,
    2
  );

  if v_amt <> v_expected then
    raise exception 'Test C FAILED: expected % (300*%(v1, unfrozen) + 400*%(v2, %d frozen of %d) / %), got %',
      v_expected, v_seg1_billable_days, v_seg2_billable_days, v_seg2_frozen_days, v_seg2_total_days, v_total_days, v_amt;
  end if;

  raise notice 'Test C PASSED: version1 segment (% days @300, unfrozen) + version2 segment (% of % days @400, %d frozen at ₪0) = %',
    v_seg1_billable_days, v_seg2_billable_days, v_seg2_total_days, v_seg2_frozen_days, v_amt;
end $$;

do $$ begin raise notice 'ALL SEGMENTATION TESTS BATCH 1 (Test B, Test C) PASSED'; end $$;
