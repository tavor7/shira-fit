-- Phase 3 billing-engine tests, batch 3: retroactive correction, idempotency, concurrency.
set client_min_messages to notice;

-- Test B9: retroactive freeze applied AFTER a charge already exists -> reversal + corrected
-- freeze_credit charge, arithmetic verified.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint;
  v_bp_id uuid; v_original public.subscription_charges%rowtype;
  v_freeze_id uuid; v_res json; v_total int; v_exp numeric;
  v_reversal_amt numeric; v_correction_amt numeric; v_net numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b9', 'Athlete B9', '0500001009', 'athlete', 'approved');

  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges(); -- bills the period at full ₪300, no freeze yet

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select * into v_original from subscription_charges where billing_period_id=v_bp_id and charge_type in ('recurring','proration');
  if v_original.amount_ils <> 300 then raise exception 'B9 setup FAILED: expected initial ₪300, got %', v_original.amount_ils; end if;

  -- NOW add a freeze retroactively covering 10 days of the already-billed period (simulating
  -- what Phase 4's freeze_subscription RPC will do after this point).
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 5, v_start + 14)
  returning id into v_freeze_id;

  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;
  v_exp := round(300::numeric * (v_total - 10) / v_total, 2);

  v_res := public.subscription_generate_or_correct_billing_period(
    v_sub, v_ver, v_start, (select period_end from subscription_billing_periods where id=v_bp_id),
    v_freeze_id, 'freeze_credit'
  );
  if coalesce((v_res->>'ok')::boolean,false) is not true or v_res->>'action' <> 'corrected' then
    raise exception 'B9 FAILED: correction call did not report corrected, got %', v_res;
  end if;

  -- Original charge untouched.
  if (select amount_ils from subscription_charges where id = v_original.id) <> 300 then
    raise exception 'B9 FAILED: original charge row was mutated';
  end if;

  select amount_ils into v_reversal_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='reversal' and reverses=v_original.id;
  if v_reversal_amt <> -300 then raise exception 'B9 FAILED: expected reversal of -300, got %', v_reversal_amt; end if;

  select amount_ils into v_correction_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='freeze_credit' and source_event_id=v_freeze_id;
  if v_correction_amt <> v_exp then raise exception 'B9 FAILED: expected corrected amount %, got %', v_exp, v_correction_amt; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> v_exp then raise exception 'B9 FAILED: net charges for period should equal %, got %', v_exp, v_net; end if;

  raise notice 'B9 PASSED: retroactive freeze correction -- original untouched, reversal -300, freeze_credit %, net %', v_correction_amt, v_net;

  create table if not exists _billing_ids3 (k text primary key, v uuid);
  insert into _billing_ids3 values ('b9_sub', v_sub), ('b9_ver', v_ver), ('b9_bp', v_bp_id), ('b9_freeze', v_freeze_id)
  on conflict do nothing;
end $$;

-- Test B11 (idempotency, using B9's exact setup): applying the SAME freeze correction again
-- (simulating a retry) must produce exactly one reversal + one correction, not two.
do $$
declare
  v_sub uuid; v_ver uuid; v_bp_id uuid; v_freeze_id uuid; v_res json;
  v_reversal_count int; v_correction_count int; v_net numeric; v_exp numeric; v_total int; v_start date;
begin
  select v into v_sub from _billing_ids3 where k='b9_sub';
  select v into v_ver from _billing_ids3 where k='b9_ver';
  select v into v_bp_id from _billing_ids3 where k='b9_bp';
  select v into v_freeze_id from _billing_ids3 where k='b9_freeze';
  select period_start into v_start from subscription_billing_periods where id=v_bp_id;
  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;
  v_exp := round(300::numeric * (v_total - 10) / v_total, 2);

  v_res := public.subscription_generate_or_correct_billing_period(
    v_sub, v_ver, v_start, (select period_end from subscription_billing_periods where id=v_bp_id),
    v_freeze_id, 'freeze_credit'
  );
  -- Post-audit fix: the retry now resolves to 'unchanged' rather than 'already_corrected',
  -- because the correction lookup was fixed to find the CURRENTLY EFFECTIVE charge (the
  -- freeze_credit correction itself, amount 200) instead of always "the original" — on retry,
  -- the freshly recomputed amount (200) matches the already-effective charge (200) exactly, so
  -- it is correctly recognized as a no-op before ever considering source_event_id. The dedicated
  -- 'already_corrected' (source_event_id-keyed) path remains as a defensive backstop for a true
  -- concurrent race, but is no longer what a simple sequential retry hits. Either outcome is a
  -- correct no-op; what matters (checked below) is that no duplicate reversal/correction rows
  -- are created and the net amount is unchanged.
  if v_res->>'action' not in ('unchanged', 'already_corrected') then
    raise exception 'B11 FAILED: retried correction should be a no-op (unchanged/already_corrected), got %', v_res;
  end if;

  select count(*) into v_reversal_count from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal';
  select count(*) into v_correction_count from subscription_charges where billing_period_id=v_bp_id and charge_type='freeze_credit';
  if v_reversal_count <> 1 then raise exception 'B11 FAILED: expected exactly 1 reversal, got %', v_reversal_count; end if;
  if v_correction_count <> 1 then raise exception 'B11 FAILED: expected exactly 1 correction, got %', v_correction_count; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> v_exp then raise exception 'B11 FAILED: net should still be %, got %', v_exp, v_net; end if;

  raise notice 'B11 PASSED: repeated correction-event retry is a no-op -- exactly 1 reversal + 1 correction';
end $$;

-- Test B10: retroactive STOP applied after a charge already exists -> reversal + stop_proration
-- correction, arithmetic verified.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_anchor smallint;
  v_bp_id uuid; v_original public.subscription_charges%rowtype; v_stop date;
  v_res json; v_total int; v_exp numeric; v_reversal_amt numeric; v_correction_amt numeric; v_net numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b10', 'Athlete B10', '0500001010', 'athlete', 'approved');

  v_start := current_date - 20;
  v_anchor := extract(day from v_start)::int::smallint;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, v_anchor, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges(); -- bills full ₪300

  select id into v_bp_id from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;
  select * into v_original from subscription_charges where billing_period_id=v_bp_id and charge_type in ('recurring','proration');

  -- Retroactively stop 12 days into the already-billed period.
  v_stop := v_start + 12;
  update subscription_versions set stopped_effective_date = v_stop where id = v_ver;

  select period_end - period_start into v_total from subscription_billing_periods where id=v_bp_id;
  v_exp := round(300::numeric * 12 / v_total, 2);

  v_res := public.subscription_generate_or_correct_billing_period(
    v_sub, v_ver, v_start, (select period_end from subscription_billing_periods where id=v_bp_id),
    v_ver, 'stop_proration' -- source_event_id = the stopped version's own id, per the plan
  );
  if coalesce((v_res->>'ok')::boolean,false) is not true or v_res->>'action' <> 'corrected' then
    raise exception 'B10 FAILED: correction call did not report corrected, got %', v_res;
  end if;

  if (select amount_ils from subscription_charges where id=v_original.id) <> 300 then
    raise exception 'B10 FAILED: original charge row was mutated';
  end if;

  select amount_ils into v_reversal_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='reversal' and reverses=v_original.id;
  if v_reversal_amt <> -300 then raise exception 'B10 FAILED: expected reversal -300, got %', v_reversal_amt; end if;

  select amount_ils into v_correction_amt from subscription_charges
  where billing_period_id=v_bp_id and charge_type='stop_proration' and source_event_id=v_ver;
  if v_correction_amt <> v_exp then raise exception 'B10 FAILED: expected corrected amount %, got %', v_exp, v_correction_amt; end if;

  select sum(amount_ils) into v_net from subscription_charges where billing_period_id=v_bp_id;
  if v_net <> v_exp then raise exception 'B10 FAILED: net should be %, got %', v_exp, v_net; end if;

  -- Idempotency: retry produces no duplicate.
  v_res := public.subscription_generate_or_correct_billing_period(
    v_sub, v_ver, v_start, (select period_end from subscription_billing_periods where id=v_bp_id),
    v_ver, 'stop_proration'
  );
  if v_res->>'action' not in ('unchanged', 'already_corrected') then
    raise exception 'B10 FAILED: retry should be a no-op (unchanged/already_corrected), got %', v_res;
  end if;
  if (select count(*) from subscription_charges where billing_period_id=v_bp_id and charge_type='reversal') <> 1 then
    raise exception 'B10 FAILED: retry created a duplicate reversal';
  end if;

  raise notice 'B10 PASSED: retroactive stop correction -- reversal -300, stop_proration %, net %, retry-safe', v_correction_amt, v_net;
end $$;

-- Test B12: repeated billing-job idempotency for a single due period (targeted, single-process).
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date;
  v_count1 int; v_count2 int;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b12', 'Athlete B12', '0500001012', 'athlete', 'approved');

  v_start := current_date - 3;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges();
  select count(*) into v_count1 from subscription_billing_periods where subscription_id=v_sub;

  perform public.generate_due_subscription_charges();
  perform public.generate_due_subscription_charges();
  select count(*) into v_count2 from subscription_billing_periods where subscription_id=v_sub;

  if v_count1 <> 1 or v_count2 <> 1 then
    raise exception 'B12 FAILED: expected exactly 1 period after repeated runs, got % then %', v_count1, v_count2;
  end if;
  if (select count(*) from subscription_charges c join subscription_billing_periods bp on bp.id=c.billing_period_id
        where bp.subscription_id=v_sub and c.charge_type in ('recurring','proration')) <> 1 then
    raise exception 'B12 FAILED: expected exactly 1 original charge after repeated runs';
  end if;
  raise notice 'B12 PASSED: repeated billing-job runs for the same due period are fully idempotent';
end $$;

do $$ begin raise notice 'ALL BILLING TESTS BATCH 3 (B9-B12) PASSED'; end $$;
