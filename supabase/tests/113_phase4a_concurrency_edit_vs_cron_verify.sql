-- Race 1 verification: run after both 111 (edit) and 112 (cron) have completed.
set client_min_messages to notice;

do $$
declare
  v_sub uuid;
  v_bp1_id uuid;
  v_bp_count int;
  v_reversal_count int;
  v_original_count int;
  v_current_charge record;
  v_res json;
  v_start date := current_date - 40;
begin
  select v into v_sub from _p4a_race_ids where k = 'sub1';

  -- No deadlock / crash: both processes must have left the subscription in a well-formed state
  -- (this query succeeding at all, with exactly one current version, is itself part of the proof).
  if (select count(*) from subscription_versions where subscription_id = v_sub and effective_to is null) <> 1 then
    raise exception 'RACE1 FAILED: expected exactly one current version after the race';
  end if;

  select id into v_bp1_id from subscription_billing_periods where subscription_id = v_sub and period_start = v_start;

  -- No duplicate "original" charge for period 1 (the unique index would have raised a hard error
  -- otherwise, but double-check explicitly): exactly one recurring/proration charge ever existed.
  select count(*) into v_original_count from subscription_charges
  where billing_period_id = v_bp1_id and charge_type in ('recurring', 'proration');
  if v_original_count <> 1 then
    raise exception 'RACE1 FAILED: expected exactly 1 original charge for period 1, got %', v_original_count;
  end if;

  -- No lost correction: the edit's correction must have gone through — exactly one reversal +
  -- exactly one edit_correction for period 1, and the currently-effective (non-reversed) charge
  -- reflects the post-edit blended amount, never the stale pre-edit 300.
  select count(*) into v_reversal_count from subscription_charges
  where billing_period_id = v_bp1_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then
    raise exception 'RACE1 FAILED: expected exactly 1 reversal (the edit''s correction), got %. Cron must not have clobbered or duplicated it.', v_reversal_count;
  end if;

  select c.* into v_current_charge from subscription_charges c
  where c.billing_period_id = v_bp1_id and c.charge_type <> 'reversal'
    and not exists (select 1 from subscription_charges rv where rv.charge_type = 'reversal' and rv.reverses = c.id)
  order by c.created_at desc, c.id desc limit 1;
  if v_current_charge.amount_ils = 300 then
    raise exception 'RACE1 FAILED: currently-effective charge still shows the stale pre-edit 300 -- correction was lost';
  end if;
  if v_current_charge.charge_type <> 'edit_correction' then
    raise exception 'RACE1 FAILED: expected the currently-effective charge to be the edit_correction, got type %', v_current_charge.charge_type;
  end if;
  raise notice 'RACE1 PASSED (no lost correction): final ledger amount for period 1 is % (edit_correction), matching the intended post-edit configuration', v_current_charge.amount_ils;

  -- Idempotency rerun: re-running BOTH sides again must be a clean no-op / convergent retry.
  perform set_config('app.current_uid', (select v from _p4a_race_ids where k = 'manager')::text, true);
  v_res := public.edit_subscription_version(v_sub, v_start + 10, 200, null, false, null, true);
  if v_res->>'action' <> 'already_applied' then
    raise exception 'RACE1 FAILED: re-running the same confirmed edit after the race must be idempotent (already_applied), got %', v_res;
  end if;

  v_res := public.generate_due_subscription_charges();
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'RACE1 FAILED: cron rerun after the race must succeed cleanly, got %', v_res;
  end if;

  select count(*) into v_reversal_count from subscription_charges
  where billing_period_id = v_bp1_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then
    raise exception 'RACE1 FAILED: rerun created a duplicate reversal (count=%)', v_reversal_count;
  end if;

  raise notice 'RACE1 PASSED (idempotent rerun): no duplicate charges, no deadlock, final state stable';
end $$;
