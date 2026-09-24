-- Test D/E: retroactive version change after a period was already charged, then a FURTHER
-- retroactive correction on top -- the sequential-correction invariant applied to the new
-- multi-version segmentation logic.
set client_min_messages to notice;

-- Test D: period originally billed at ₪300 (single version, full price). A new version is
-- inserted RETROACTIVELY inside that already-charged period (effective from day 12, ₪450).
-- Recompute the complete intended amount via the segmentation algorithm and correct to it.
do $$
declare
  v_p uuid; v_sub uuid; v_ver1 uuid; v_ver2 uuid;
  v_start date; v_anchor smallint; v_end date; v_retro date; v_total_days int;
  v_bp_id uuid; v_original public.subscription_charges%rowtype;
  v_res json; v_expected numeric; v_reversal_amt numeric; v_correction_amt numeric; v_net numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_d_test', 'Athlete DTest', '0500003003', 'athlete', 'approved');

  v_start := current_date - 5;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver1;

  -- Bill it normally first, at full ₪300 (single-version period, as before this pass).
  perform public.generate_due_subscription_charges();
  select id, period_end into v_bp_id, v_end from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select * into v_original from subscription_charges where billing_period_id=v_bp_id and charge_type in ('recurring','proration');
  if v_original.amount_ils <> 300 then raise exception 'Test D setup FAILED: expected initial 300, got %', v_original.amount_ils; end if;
  v_total_days := v_end - v_start;

  -- NOW retroactively insert a new version effective from day 12 of the ALREADY-BILLED period,
  -- at a new price (simulating what Phase 4's edit_subscription_version RPC will do: close
  -- version1's effective_to at the new version's effective_from, open version2).
  v_retro := v_start + 12;
  update public.subscription_versions set effective_to = v_retro where id = v_ver1;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 2, v_retro, 450, v_anchor, v_start) returning id into v_ver2;

  v_expected := round((300::numeric * (v_retro - v_start) + 450::numeric * (v_end - v_retro)) / v_total_days, 2);

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver2, v_start, v_end, v_ver2, 'stop_proration');
  if coalesce((v_res->>'ok')::boolean,false) is not true or v_res->>'action' <> 'corrected' then
    raise exception 'Test D FAILED: correction call did not apply: %', v_res;
  end if;

  if (select amount_ils from subscription_charges where id = v_original.id) <> 300 then
    raise exception 'Test D FAILED: original charge row was mutated';
  end if;

  select amount_ils into v_reversal_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='reversal' and reverses=v_original.id;
  if v_reversal_amt <> -300 then raise exception 'Test D FAILED: expected reversal -300, got %', v_reversal_amt; end if;

  select amount_ils into v_correction_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='stop_proration' and source_event_id=v_ver2;
  if v_correction_amt <> v_expected then raise exception 'Test D FAILED: expected corrected %, got %', v_expected, v_correction_amt; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> v_expected then raise exception 'Test D FAILED: net should be %, got %', v_expected, v_net; end if;

  raise notice 'Test D PASSED: retroactive version change (300 -> segmented 300/450 at day 12 of %) -- reversal -300, correction %, net exactly %',
    v_total_days, v_correction_amt, v_net;

  create table if not exists _seg_ids (k text primary key, v uuid);
  insert into _seg_ids values ('sub', v_sub), ('ver2', v_ver2), ('bp', v_bp_id), ('start', null) on conflict do nothing;
  -- store v_start/v_end/v_total_days for Test E via a side table since _seg_ids is uuid-typed
  create table if not exists _seg_dates (k text primary key, v date);
  insert into _seg_dates values ('start', v_start), ('end', v_end) on conflict (k) do update set v = excluded.v;
end $$;

-- Test E: a FURTHER retroactive correction applied after Test D's correction (another version
-- change, this time effective from day 20, at ₪500 for the remainder). The sequential-correction
-- invariant must still hold: the new reversal targets the CURRENTLY EFFECTIVE charge (Test D's
-- stop_proration correction, not the original ₪300), and the final net equals the NEWEST
-- complete intended amount -- not stacked, not double-reversed.
do $$
declare
  v_sub uuid; v_ver2 uuid; v_ver3 uuid; v_bp_id uuid;
  v_start date; v_end date; v_total_days int; v_retro2 date;
  v_res json; v_expected numeric; v_net numeric; v_rev_count int;
  v_prior_correction_id uuid; v_second_reversal record;
begin
  select v into v_sub from _seg_ids where k='sub';
  select v into v_ver2 from _seg_ids where k='ver2';
  select v into v_bp_id from _seg_ids where k='bp';
  select v into v_start from _seg_dates where k='start';
  select v into v_end from _seg_dates where k='end';
  v_total_days := v_end - v_start;

  select id into v_prior_correction_id from subscription_charges
  where billing_period_id = v_bp_id and charge_type = 'stop_proration';

  -- Another retroactive edit: close version2 at day 20, open version3 at ₪500 for the rest.
  v_retro2 := v_start + 20;
  update public.subscription_versions set effective_to = v_retro2 where id = v_ver2;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 3, v_retro2, 500, extract(day from v_start)::int, v_start) returning id into v_ver3;

  -- Newest intended amount spans THREE segments now: [start,retro1)@300, [retro1,retro2)@450,
  -- [retro2,end)@500 (retro1 = start+12 from Test D).
  v_expected := round(
    (300::numeric * 12 + 450::numeric * (v_retro2 - (v_start+12)) + 500::numeric * (v_end - v_retro2))
    / v_total_days, 2
  );

  v_res := public.subscription_generate_or_correct_billing_period(v_sub, v_ver3, v_start, v_end, v_ver3, 'stop_proration');
  if coalesce((v_res->>'ok')::boolean,false) is not true or v_res->>'action' <> 'corrected' then
    raise exception 'Test E FAILED: second correction did not apply: %', v_res;
  end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> v_expected then
    raise exception 'Test E FAILED: expected final net % (three segments: 12d@300 + %d@450 + %d@500 / %d), got %',
      v_expected, (v_retro2-(v_start+12)), (v_end-v_retro2), v_total_days, v_net;
  end if;

  select count(*) into v_rev_count from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal';
  if v_rev_count <> 2 then raise exception 'Test E FAILED: expected exactly 2 reversals total (one per correction), got %', v_rev_count; end if;

  select * into v_second_reversal from subscription_charges
  where billing_period_id=v_bp_id and charge_type='reversal' and source_event_id=v_ver3;
  if v_second_reversal.reverses <> v_prior_correction_id then
    raise exception 'Test E FAILED: second reversal should target Test D''s correction (%), targets %', v_prior_correction_id, v_second_reversal.reverses;
  end if;

  raise notice 'Test E PASSED: sequential-correction invariant holds under multi-version segmentation -- final net exactly % (not stacked, second reversal correctly targets the prior correction, not the original ₪300)', v_net;
end $$;

do $$ begin raise notice 'ALL SEGMENTATION TESTS BATCH 2 (Test D, Test E) PASSED'; end $$;
