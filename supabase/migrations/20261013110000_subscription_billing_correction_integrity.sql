-- Billing integrity: fix duplicate billing after a freeze and under-correction of multi-period corrections.
--
-- Two defects in the subscription correction path, both reproduced deterministically through the real API path
-- (supabase/tests/159_subscription_billing_integrity_tests.sh) before this migration:
--
-- (A) DUPLICATE BILLING AFTER A FREEZE. 20260928141108 changed subscription_generate_or_correct_billing_period to take
--     RAW (unshifted) period bounds -- it adds the cumulative frozen days itself and upserts on
--     unique (subscription_id, raw_period_start) -- and updated freeze_subscription and stop_subscription accordingly, but
--     edit_subscription_version was never redefined and still passes the EFFECTIVE (already shifted) dates. On any
--     subscription with a freeze, an edit therefore shifted the period a second time, missed the existing row and
--     inserted a NEW billing period for the same cycle with a fresh full recurring/proration charge (reproduced: a freeze
--     plus one price edit turned 4 periods into 6; freeze/edit/freeze/edit turned 4 into 14, all charged).
--     Fix: the edit loop passes bp.raw_period_start / bp.raw_period_end, like stop and freeze.
--
-- (B) ONLY ONE PERIOD CORRECTED PER ACTION. One action (stop / freeze / edit) uses ONE deterministic source_event_id for
--     every billing period it corrects, but the engine returned 'already_corrected' as soon as ANY reversal carried that
--     id, and the unique index on (source_event_id, charge_type) would have rejected a second reversal anyway. A
--     retroactive stop (or a retroactive price edit) spanning two or more already-billed periods therefore corrected only
--     the first period the (unordered) loop reached; the others kept their full charge (reproduced: stop backdated into
--     August left September and October at ₪300 where the engine's own amount is ₪0; a backdated price edit likewise).
--     Fix: idempotency is per (source_event_id, charge_type, billing_period_id) -- the already_corrected check is scoped
--     to the period and the unique index gains billing_period_id. A retry of the same action still converges (the
--     per-action impact event short-circuits it first; per period the reversal check / unique index / amount equality
--     do). Stop also corrects periods in raw_period_start order (deterministic, like freeze).
--
-- Ledger semantics are unchanged: corrections stay append-only (a `reversal` of the active charge plus a new charge);
-- no charge, billing period, payment, receipt/document or summary row is ever updated or deleted by this migration or by
-- the corrected code. Existing rows are NOT modified: any duplicate periods or under-corrected periods that already exist
-- in a database are left in place for an explicit, reviewed reconciliation (see the read-only diagnostics shipped with
-- this change). The new unique index is strictly wider than the old one, so every existing row satisfies it.

-- Wider idempotency index first (existing rows satisfy it: they already satisfy the narrower one), then drop the old one.
create unique index if not exists subscription_charges_source_event_period_uidx
  on public.subscription_charges (source_event_id, charge_type, billing_period_id)
  where source_event_id is not null;
drop index if exists public.subscription_charges_source_event_uidx;
comment on index public.subscription_charges_source_event_period_uidx is
  'Idempotency guard for correction charges: one reversal and one correction per (action source_event_id, billing period).';

-- (1) Billing engine: per-period idempotency. Body identical to 20260928141108 except the already_corrected check.
create or replace function public.subscription_generate_or_correct_billing_period(
  p_subscription_id uuid,
  p_version_id uuid,
  p_raw_period_start date,
  p_raw_period_end date,
  p_source_event_id uuid default null,
  p_correction_charge_type public.subscription_charge_type default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bp_id uuid;
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_frozen_days int;
  v_period_start date;
  v_period_end date;
  v_amount record;
  v_new_amount numeric(12, 2);
  v_new_type public.subscription_charge_type;
  v_existing public.subscription_charges%rowtype;
begin
  if not exists (
    select 1 from public.subscription_versions where id = p_version_id and subscription_id = p_subscription_id
  ) then
    if not exists (select 1 from public.subscription_versions where id = p_version_id) then
      return json_build_object('ok', false, 'error', 'version_not_found');
    end if;
    return json_build_object('ok', false, 'error', 'version_subscription_mismatch');
  end if;

  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  v_frozen_days := public.subscription_total_frozen_days(p_subscription_id, p_raw_period_end);
  v_period_start := p_raw_period_start + v_frozen_days;
  v_period_end := p_raw_period_end + v_frozen_days;

  insert into public.subscription_billing_periods (
    subscription_id, version_id, period_start, period_end,
    raw_period_start, raw_period_end, frozen_days_applied
  )
  values (
    p_subscription_id, p_version_id, v_period_start, v_period_end,
    p_raw_period_start, p_raw_period_end, v_frozen_days
  )
  on conflict (subscription_id, raw_period_start) do nothing
  returning id into v_bp_id;

  if v_bp_id is null then
    select id into v_bp_id
    from public.subscription_billing_periods
    where subscription_id = p_subscription_id and raw_period_start = p_raw_period_start;
  end if;

  -- Keep the row's version_id, and its effective dates/frozen_days_applied, current -- a freeze
  -- created after this period already existed must immediately shift it (period_start/period_end
  -- are scheduling metadata, safe to update in place; the financial ledger rows are the only thing
  -- this function ever treats as immutable-except-via-reversal).
  update public.subscription_billing_periods
  set version_id = p_version_id,
      period_start = v_period_start,
      period_end = v_period_end,
      frozen_days_applied = v_frozen_days
  where id = v_bp_id
    and (
      version_id is distinct from p_version_id
      or period_start is distinct from v_period_start
      or period_end is distinct from v_period_end
      or frozen_days_applied is distinct from v_frozen_days
    );

  select * into v_amount
  from public.subscription_billing_period_amount(p_subscription_id, v_period_start, v_period_end);
  v_new_amount := v_amount.amount_ils;

  select c.* into v_existing
  from public.subscription_charges c
  where c.billing_period_id = v_bp_id
    and c.charge_type <> 'reversal'
    and not exists (
      select 1 from public.subscription_charges rv
      where rv.charge_type = 'reversal' and rv.reverses = c.id
    )
  order by c.created_at desc, c.id desc
  limit 1;

  if not found then
    v_new_type := case when v_amount.is_full_recurring
                        then 'recurring'::public.subscription_charge_type
                        else 'proration'::public.subscription_charge_type
                   end;
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
    ) values (
      v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual, v_new_amount, v_new_type, null
    );
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'created',
      'amount_ils', v_new_amount, 'charge_type', v_new_type,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

  if v_existing.amount_ils = v_new_amount then
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'unchanged', 'amount_ils', v_existing.amount_ils,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

  if p_correction_charge_type is null then
    return json_build_object('ok', false, 'error', 'correction_charge_type_required');
  end if;

  -- Idempotency is per (action, billing period): one action (a stop, freeze or edit) may have to correct SEVERAL
  -- periods, each exactly once. (Previously ANY reversal for the action short-circuited every other period.)
  if p_source_event_id is not null and exists (
    select 1 from public.subscription_charges
    where source_event_id = p_source_event_id and charge_type = 'reversal' and billing_period_id = v_bp_id
  ) then
    return json_build_object('ok', true, 'billing_period_id', v_bp_id, 'action', 'already_corrected');
  end if;

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    -v_existing.amount_ils, 'reversal', v_existing.id, p_source_event_id
  );

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    v_new_amount, p_correction_charge_type, p_source_event_id
  );

  return json_build_object(
    'ok', true, 'billing_period_id', v_bp_id, 'action', 'corrected',
    'amount_ils', v_new_amount, 'charge_type', p_correction_charge_type,
    'reversed_ils', v_existing.amount_ils,
    'period_start', v_period_start, 'period_end', v_period_end
  );
exception
  when unique_violation then
    return json_build_object('ok', true, 'action', 'concurrent_noop');
end;
$$;


-- (2) Edit: pass raw period bounds (and correct periods in order). Body identical to 20260924150000 except the loop.
create or replace function public.edit_subscription_version(
  p_subscription_id uuid,
  p_effective_from date,
  p_new_price numeric default null,
  p_new_plan_end_date date default null,
  p_clear_end_date boolean default false, -- explicit "remove end date" intent; NEVER touches allowances
  p_new_allowances jsonb default null,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  v_new_version_id uuid;
  v_new_plan_end_date date;
  v_has_history boolean;
  v_rows int;
  r record;
  v_res json;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_price is not null and p_new_price < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_effective_from is null then
    return json_build_object('ok', false, 'error', 'effective_from_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  -- Server-side impact recompute, always — never trust a client-supplied earlier preview, whether
  -- this is the first preview call or the confirmed application.
  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'edit',
    null, null, null,
    p_effective_from, p_new_price, p_new_plan_end_date, p_clear_end_date, p_new_allowances
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

  -- Idempotency (fixed — pre-merge review round 2): the key MUST distinguish a true retry of the
  -- identical request from a genuinely distinct edit that happens to share a subscription/date.
  -- Hashing subscription+action+date ALONE (the original design) collapsed two different edits
  -- effective on the same date into one "operation" — e.g. price 300 then a later, deliberate
  -- price 350 correction for the same date would have been misread as a retry of the first and
  -- silently dropped. The key now incorporates every business-relevant field actually being
  -- changed (price, resulting plan_end_date, and the canonical text form of the allowances jsonb,
  -- which is stable/order-independent since Postgres normalizes jsonb on parse) so two payloads
  -- differing in ANY of those fields always produce different keys, while two calls with an
  -- identical payload converge to the same key (a true retry).
  declare
    v_source_id uuid := md5(
      p_subscription_id::text || '|edit|' || p_effective_from::text || '|' ||
      coalesce(p_new_price::text, 'null') || '|' ||
      coalesce(v_new_plan_end_date::text, 'null') || '|' ||
      coalesce(p_new_allowances::text, 'null')
    )::uuid;
  begin
    if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
               and action_type = 'edit' and action_source_id = v_source_id and confirmed = true) then
      return json_build_object('ok', true, 'action', 'already_applied');
    end if;

    if p_effective_from < v_current.effective_from then
      return json_build_object('ok', false, 'error', 'effective_from_before_current_version');
    end if;

    if p_effective_from = v_current.effective_from then
      -- Safety check (fixed — pre-merge review round 2): re-verified fresh against the live schema
      -- that the only two tables referencing subscription_versions.id are
      -- subscription_billing_periods.version_id and subscription_registration_coverage.version_id
      -- (subscription_version_allowances also references it, but every version has allowance rows
      -- immediately upon creation — that is configuration, not history, and is excluded here).
      select exists (
        select 1 from public.subscription_billing_periods where version_id = v_current.id
        union all
        select 1 from public.subscription_registration_coverage where version_id = v_current.id
      ) into v_has_history;

      if not v_has_history then
        -- Case (a): brand-new version, nothing depends on it yet — safe to update in place.
        update public.subscription_versions
        set monthly_price_ils = coalesce(p_new_price, v_current.monthly_price_ils),
            plan_end_date = v_new_plan_end_date
        where id = v_current.id;
        v_new_version_id := v_current.id;

        if p_new_allowances is not null then
          delete from public.subscription_version_allowances where version_id = v_current.id;
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_current.id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        end if;
      else
        -- Case (b): history already exists against this exact version. Never mutate it in place —
        -- close it with effective_to = its OWN effective_from (a deliberate, explicitly-safe
        -- zero-width case; see 20260924146000's constraint-relaxation comment for the proof that a
        -- zero-width version can never match any real billing segment) and insert a genuinely new
        -- version at that same date. The original row's fields are never touched, preserving full
        -- auditability, while "from the beginning" semantics and correct corrections are honored
        -- via the normal reconcile/billing-correction steps below.
        update public.subscription_versions
        set effective_to = p_effective_from
        where id = v_current.id and effective_to is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          return json_build_object('ok', false, 'error', 'concurrent_modification');
        end if;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_uid
        ) returning id into v_new_version_id;

        update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

        if p_new_allowances is not null then
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        else
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, tier, weekly_limit
          from public.subscription_version_allowances where version_id = v_current.id;
        end if;
      end if;
    else
      update public.subscription_versions
      set effective_to = p_effective_from
      where id = v_current.id and effective_to is null;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', false, 'error', 'concurrent_modification');
      end if;

      insert into public.subscription_versions (
        subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
        plan_start_date, plan_end_date, created_by
      ) values (
        p_subscription_id,
        (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
        p_effective_from,
        coalesce(p_new_price, v_current.monthly_price_ils),
        v_current.anchor_day,
        v_current.plan_start_date,
        v_new_plan_end_date,
        v_uid
      ) returning id into v_new_version_id;

      update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

      if p_new_allowances is not null then
        insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
        select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
        from jsonb_array_elements(p_new_allowances) a;
      else
        insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
        select v_new_version_id, tier, weekly_limit
        from public.subscription_version_allowances where version_id = v_current.id;
      end if;
    end if;

    -- Reconcile every affected (tier, week_start) for real.
    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (p_effective_from - extract(dow from p_effective_from)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    -- Billing corrections for every existing billing period that overlaps the new version's
    -- effective window, through the Phase 3 correction engine, keyed to this edit's deterministic
    -- (now payload-inclusive) source_event_id (idempotent — a retry converges to
    -- 'unchanged'/'already_corrected').
    -- The engine takes RAW (unshifted) period bounds and adds the frozen days itself (20260928141108); passing the
    -- already-shifted effective dates made it shift twice, miss the existing row (unique on raw_period_start) and
    -- insert a duplicate billing period with a second full charge whenever the subscription had a freeze.
    for r in
      select bp.raw_period_start, bp.raw_period_end
      from public.subscription_billing_periods bp
      where bp.subscription_id = p_subscription_id
        and bp.period_end > p_effective_from
      order by bp.raw_period_start asc
    loop
      perform public.subscription_generate_or_correct_billing_period(
        p_subscription_id, v_new_version_id, r.raw_period_start, r.raw_period_end,
        v_source_id, 'edit_correction'
      );
    end loop;

    insert into public.subscription_impact_events (
      subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
    ) values (
      p_subscription_id, 'edit', v_source_id, p_effective_from, true, v_uid
    )
    on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

    return json_build_object('ok', true, 'action', 'applied', 'version_id', v_new_version_id, 'impact', v_impact);
  end;
end;
$$;


-- (3) Stop: deterministic order. Body identical to 20260928141108 except the ORDER BY.
create or replace function public.stop_subscription(
  p_subscription_id uuid,
  p_stop_date date,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  v_impact := public.subscription_compute_impact(p_subscription_id, 'stop', null, null, p_stop_date);
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|stop|' || p_stop_date::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_stop_date - extract(dow from p_stop_date)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end > p_stop_date
    order by bp.raw_period_start asc
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_source_id, 'stop_proration'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object('ok', true, 'action', 'applied', 'impact', v_impact);
end;
$$;


-- Self-check: the fixed definitions are in place, privileges unchanged, idempotency index swapped.
do $$
begin
  if to_regclass('public.subscription_charges_source_event_uidx') is not null
     or to_regclass('public.subscription_charges_source_event_period_uidx') is null then
    raise exception 'self-check: idempotency index not swapped';
  end if;
  if position('r.raw_period_start, r.raw_period_end' in
       (select prosrc from pg_proc where oid = 'public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean)'::regprocedure)) = 0 then
    raise exception 'self-check: edit_subscription_version still passes effective dates';
  end if;
  if position('billing_period_id = v_bp_id' in
       (select prosrc from pg_proc where oid = 'public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type)'::regprocedure)) = 0 then
    raise exception 'self-check: engine idempotency is not per period';
  end if;
  -- create or replace keeps ACLs: the internal engine must still be closed to clients (20261013100000), the entry
  -- points still open to authenticated.
  if has_function_privilege('anon', 'public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: billing engine is client-executable';
  end if;
  if not has_function_privilege('authenticated', 'public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean)'::regprocedure, 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.stop_subscription(uuid, date, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager entry points lost EXECUTE';
  end if;
end $$;
