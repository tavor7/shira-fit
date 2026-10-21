-- Subscription payments: allow a manager to record a payment against a subscription (at creation
-- time, optionally, or afterward from subscription management), reusing the existing
-- athlete_account_payments ledger and every protection already built on top of it rather than
-- inventing a second financial ledger.
--
-- Architecture (see 20261023170000's own comment, which anticipated exactly this):
--   - add a nullable `source_subscription_id` to athlete_account_payments, referencing
--     subscriptions(id). A subscription payment is, in every other respect, an ordinary account
--     payment: it is picked up by _period_merged_athlete_finance's existing acct_by_ath CTE
--     (reduces outstanding balance automatically, no change needed there), it can be reversed
--     through the existing reversed_at/reversed_by mechanism, and it can be receipted through the
--     existing create_document / create_documents_from_payments flow (row_kind 'account' ->
--     source_type 'account_payment' -- unchanged mapping, no new document_source_type value).
--   - add a nullable `client_request_id` or recording idempotency (duplicate-submit / retry safety),
--     enforced by a partial unique index and an exception handler that treats a unique_violation as
--     "already recorded", returning the existing row rather than erroring.
--   - one new manager-only RPC, record_subscription_payment, for 3.2 (payments from subscription
--     management).
--   - create_subscription itself (3.1, initial payment at creation time) gains optional trailing
--     parameters for an initial payment. Since appending new parameters to an existing function
--     would create a SEPARATE overload (ambiguous against the old 7-arg call via PostgREST's named
--     parameters), the old function is dropped and replaced by one with the extended signature,
--     not two overloads. Everything happens inside the same plpgsql function body, i.e. the same
--     statement-less implicit transaction: either both the subscription and its initial payment are
--     created, or neither is (no ambiguous partial result).
--
-- Overview additions (3.6) are a brand-new, additive-only RPC (manager_subscription_overview_stats)
-- rather than touching manager_weekly_stats, which has been redefined by over a dozen migrations and
-- carries real regression risk for a change that doesn't need to live inside it. The dashboard calls
-- this new RPC in parallel with the existing one; every existing field/metric is untouched.

-- ---------------------------------------------------------------------------
-- 1. athlete_account_payments: new nullable columns.
-- ---------------------------------------------------------------------------

alter table public.athlete_account_payments
  add column if not exists source_subscription_id uuid references public.subscriptions (id) on delete set null,
  add column if not exists client_request_id uuid;

comment on column public.athlete_account_payments.source_subscription_id is
  'Set when this payment was recorded against a subscription (initial payment at creation, or from subscription management). Null for an ordinary account payment. Participates in every existing athlete_account_payments protection/calculation unchanged (balance, reversal, receipting, history locks).';
comment on column public.athlete_account_payments.client_request_id is
  'Optional client-supplied idempotency token for record_subscription_payment / create_subscription''s initial-payment path. A retry with the same token returns the already-recorded payment instead of creating a duplicate (see athlete_account_payments_client_request_id_uidx).';

create index if not exists athlete_account_payments_source_subscription_idx
  on public.athlete_account_payments (source_subscription_id)
  where source_subscription_id is not null;

create unique index if not exists athlete_account_payments_client_request_id_uidx
  on public.athlete_account_payments (client_request_id)
  where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- 2. record_subscription_payment -- manager-only, idempotent on p_client_request_id.
-- ---------------------------------------------------------------------------

create or replace function public.record_subscription_payment(
  p_subscription_id uuid,
  p_amount_ils numeric,
  p_payment_method text,
  p_payer_name text default null,
  p_note text default null,
  p_paid_at date default null,
  p_client_request_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub record;
  v_existing_id uuid;
  v_payment_id uuid;
  v_paid_at date;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- Idempotency fast path: a retry with the same token that already succeeded returns the
  -- existing payment rather than erroring or duplicating.
  if p_client_request_id is not null then
    select id into v_existing_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    if found then
      return json_build_object('ok', true, 'payment_id', v_existing_id, 'duplicate', true);
    end if;
  end if;

  if p_subscription_id is null then
    return json_build_object('ok', false, 'error', 'invalid_subscription');
  end if;

  select s.id, s.payee_id, s.payee_is_manual into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  if p_amount_ils is null or p_amount_ils <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_payment_method is null or btrim(p_payment_method) = '' then
    return json_build_object('ok', false, 'error', 'invalid_payment_method');
  end if;

  v_paid_at := coalesce(p_paid_at, public._studio_today_date());

  begin
    insert into public.athlete_account_payments (
      payee_id, payee_is_manual, amount_ils, payment_method, payer_name, note, paid_at,
      source_subscription_id, client_request_id
    ) values (
      v_sub.payee_id, v_sub.payee_is_manual, p_amount_ils, p_payment_method, p_payer_name, p_note, v_paid_at,
      v_sub.id, p_client_request_id
    )
    returning id into v_payment_id;
  exception when unique_violation then
    -- A concurrent retry with the same client_request_id raced us; converge on its row.
    select id into v_payment_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', true);
  end;

  return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', false);
end;
$$;

comment on function public.record_subscription_payment(uuid, numeric, text, text, text, date, uuid) is
  'Manager-only. Records a payment against an existing subscription as an ordinary athlete_account_payments row tagged with source_subscription_id -- no receipt is issued automatically. Idempotent via p_client_request_id: a retry with the same token returns the already-recorded payment rather than duplicating it.';

grant execute on function public.record_subscription_payment(uuid, numeric, text, text, text, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. create_subscription: extend with an optional initial payment (3.1).
-- ---------------------------------------------------------------------------
-- Precondition: refuse to run unless the current create_subscription is exactly the reviewed
-- 7-argument version this migration is designed to replace (not already extended).

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_subscription') <> 1 then
    raise exception 'precondition: create_subscription must have exactly one overload before this migration';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_subscription')
     not like '%conflicting_active_subscription%' then
    raise exception 'precondition: create_subscription does not look like the reviewed version; refusing to change it';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_subscription')
     like '%p_initial_payment%' then
    raise exception 'precondition: create_subscription already has initial-payment parameters; refusing to double-patch';
  end if;
end $$;

-- Dropped and recreated (not CREATE OR REPLACE) so the extended signature REPLACES the old one
-- instead of creating a second, ambiguous overload -- PostgREST resolves an RPC call by matching
-- named parameters against candidate overloads, and every parameter here but the new ones is
-- optional-compatible with both, which would make a plain 7-arg call ambiguous if both existed.
drop function public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb);

create function public.create_subscription(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_monthly_price_ils numeric,
  p_start_date date,
  p_end_date date default null, -- null = no end date (has_no_end_date derives to true); never affects allowances
  p_anchor_day smallint default null,
  p_allowances jsonb default '[]'::jsonb, -- [{"tier":"pair","weekly_limit":2}, ...]
  p_initial_payment_amount_ils numeric default null, -- null/omitted = no initial payment recorded
  p_initial_payment_method text default null,
  p_initial_payment_payer_name text default null,
  p_initial_payment_note text default null,
  p_initial_payment_client_request_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_subscription_id uuid;
  v_version_id uuid;
  v_anchor smallint;
  v_conflict record;
  v_tier public.subscription_tier;
  v_seen_tiers public.subscription_tier[] := '{}';
  a jsonb;
  v_limit int;
  v_payment_id uuid;
  v_existing_payment_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_monthly_price_ils is null or p_monthly_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_payee_id is null then
    return json_build_object('ok', false, 'error', 'invalid_payee');
  end if;

  -- Initial payment is optional, but if any amount is supplied it must be well-formed -- checked
  -- up front, before any insert, so a bad payment never leaves a subscription created without it
  -- (or worse, a half-created pair).
  if p_initial_payment_amount_ils is not null then
    if p_initial_payment_amount_ils <= 0 then
      return json_build_object('ok', false, 'error', 'invalid_initial_payment_amount');
    end if;
    if p_initial_payment_method is null or btrim(p_initial_payment_method) = '' then
      return json_build_object('ok', false, 'error', 'invalid_initial_payment_method');
    end if;
    -- Idempotency fast path for the whole create-with-payment call: if this exact client token
    -- already produced a payment, the subscription side already happened too (same transaction),
    -- so treat this as "already done" rather than creating a second subscription.
    if p_initial_payment_client_request_id is not null then
      select id into v_existing_payment_id
      from public.athlete_account_payments
      where client_request_id = p_initial_payment_client_request_id;
      if found then
        return json_build_object(
          'ok', true, 'subscription_id', (select source_subscription_id from public.athlete_account_payments where id = v_existing_payment_id),
          'payment_id', v_existing_payment_id, 'duplicate', true
        );
      end if;
    end if;
  end if;

  -- Exactly one valid payee identity, reusing the existing validation trigger
  -- (_validate_subscription_payee) at INSERT time below; here we only reject the obviously-wrong
  -- shape early (dual-payee XOR is inherent to the two-column model, not a two-nullable-column
  -- pattern, so there is nothing further to XOR-check at this layer).

  perform pg_advisory_xact_lock(public.subscription_payee_create_lock_key(p_payee_id, p_payee_is_manual));

  -- Conflicting-active-subscription-lineage rule (judgment call -- see migration header §2):
  -- reject if this payee already has a non-tombstoned subscription whose CURRENT version's
  -- display status as of p_start_date is not 'stopped'/'completed'.
  select s.id into v_conflict
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.payee_id = p_payee_id
    and s.payee_is_manual = coalesce(p_payee_is_manual, false)
    and s.deleted_at is null
    and public.subscription_version_display_status(v.id, p_start_date) not in ('stopped', 'completed')
  limit 1;

  if found then
    return json_build_object('ok', false, 'error', 'conflicting_active_subscription', 'subscription_id', v_conflict.id);
  end if;

  v_anchor := coalesce(p_anchor_day, extract(day from p_start_date)::smallint);
  if v_anchor < 1 or v_anchor > 31 then
    return json_build_object('ok', false, 'error', 'invalid_anchor_day');
  end if;

  insert into public.subscriptions (payee_id, payee_is_manual, created_by)
  values (p_payee_id, coalesce(p_payee_is_manual, false), v_uid)
  returning id into v_subscription_id;

  insert into public.subscription_versions (
    subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
    plan_start_date, plan_end_date, created_by
  ) values (
    v_subscription_id, 1, p_start_date, p_monthly_price_ils, v_anchor,
    p_start_date, p_end_date, v_uid
  ) returning id into v_version_id;

  -- Normalize allowances: exactly one row per subscription_tier, defaulting an unspecified tier to
  -- weekly_limit 0 (tier not included), validating each supplied entry is a real tier with a
  -- non-negative integer limit. Stored exactly as configured, regardless of duration/end-date --
  -- has_no_end_date (derived from p_end_date) never affects weekly_limit in any way.
  for v_tier in select unnest(enum_range(null::public.subscription_tier)) loop
    v_limit := 0;
    for a in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
      if (a->>'tier')::public.subscription_tier = v_tier then
        v_limit := (a->>'weekly_limit')::int;
      end if;
    end loop;
    if v_limit is null or v_limit < 0 then
      return json_build_object('ok', false, 'error', 'invalid_allowance', 'tier', v_tier::text);
    end if;
    insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
    values (v_version_id, v_tier, v_limit);
  end loop;

  -- Immediate first billing if the start date is today/past -- reuses the exact Phase 3 engine,
  -- the same call generate_due_subscription_charges makes for a subscription's first period. If
  -- p_start_date is in the future, this call's own guard (v_next_start > v_today check lives in
  -- the daily job, not here) is replicated inline: only bill immediately when due.
  if p_start_date <= public._studio_today_date() then
    perform public.subscription_generate_or_correct_billing_period(
      v_subscription_id, v_version_id, p_start_date,
      public.subscription_next_anchor_date(v_anchor, p_start_date),
      null, null
    );
  end if;

  -- Initial payment (3.1): recorded as an ordinary athlete_account_payments row tagged to this
  -- subscription, in the SAME transaction as the subscription itself (this is a single plpgsql
  -- function invocation -- there is no implicit commit between statements), so a failure here
  -- rolls back the subscription too rather than leaving it payment-less and ambiguous. No receipt
  -- is issued. Partial/overpayment amounts are both allowed -- no comparison to the monthly price
  -- is enforced server-side (the UI defaults the field to the monthly price, but the manager may
  -- change it either way).
  if p_initial_payment_amount_ils is not null then
    begin
      insert into public.athlete_account_payments (
        payee_id, payee_is_manual, amount_ils, payment_method, payer_name, note, paid_at,
        source_subscription_id, client_request_id
      ) values (
        p_payee_id, coalesce(p_payee_is_manual, false), p_initial_payment_amount_ils, p_initial_payment_method,
        p_initial_payment_payer_name, p_initial_payment_note, public._studio_today_date(),
        v_subscription_id, p_initial_payment_client_request_id
      )
      returning id into v_payment_id;
    exception when unique_violation then
      select id into v_payment_id
      from public.athlete_account_payments
      where client_request_id = p_initial_payment_client_request_id;
    end;
  end if;

  return json_build_object(
    'ok', true, 'subscription_id', v_subscription_id, 'version_id', v_version_id,
    'payment_id', v_payment_id
  );
end;
$$;

comment on function public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb, numeric, text, text, text, uuid) is
  'Manager-only. Creates a new subscription lineage (subscriptions + first subscription_versions + '
  'subscription_version_allowances row), rejecting a conflicting non-tombstoned lineage for the '
  'same payee, then invokes the existing Phase 3 billing engine for the first period if due today. '
  'p_end_date = null means no end date (has_no_end_date derives to true); this never affects '
  'p_allowances, which is always stored exactly as configured. 2026-10-24: accepts an optional '
  'initial payment (p_initial_payment_*), recorded in the same transaction as an ordinary '
  'athlete_account_payments row tagged with source_subscription_id; no receipt is issued.';

grant execute on function public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb, numeric, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. manager_subscription_overview_stats -- new, strictly additive Overview metrics (3.6).
-- ---------------------------------------------------------------------------
-- Deliberately NOT folded into manager_weekly_stats (redefined by a dozen+ prior migrations,
-- real regression risk for an unrelated addition). Reuses existing tables directly rather than
-- re-deriving anything manager_weekly_stats / _period_merged_athlete_finance already computes, so
-- there is no double-counting risk: "charges" and "payments" here are a NEW breakdown (by
-- subscription vs. not) of numbers that were previously only visible merged into the athlete
-- totals; "active" and "outstanding" are new metrics with no existing counterpart at all.

create or replace function public.manager_subscription_overview_stats(
  p_start date,
  p_end date
)
returns json
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_active_count int;
  v_charges_total numeric;
  v_payments_total numeric;
  v_lifetime_charges numeric;
  v_lifetime_payments numeric;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    return json_build_object('ok', false, 'error', 'invalid_range');
  end if;

  -- Point-in-time count, not period-scoped: "how many subscriptions are active right now".
  select count(*) into v_active_count
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) in ('active', 'frozen');

  -- Charges whose billing period starts within the requested range (the "expected" side).
  select coalesce(sum(c.amount_ils), 0) into v_charges_total
  from public.subscription_charges c
  join public.subscription_billing_periods bp on bp.id = c.billing_period_id
  where bp.period_start between p_start and p_end
    and c.charge_type in ('recurring', 'proration');

  -- Subscription-tagged payments recorded within the requested range (the "collected" side) --
  -- same reversed_at exclusion as every other consumer of this table.
  select coalesce(sum(a.amount_ils), 0) into v_payments_total
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null
    and a.paid_at between p_start and p_end;

  -- Lifetime outstanding across every subscription (not period-scoped): unreversed recurring/
  -- proration charges minus subscription-tagged payments ever recorded. May be negative
  -- (overpayment credit) -- reported as-is, matching the existing outstanding_ils convention.
  select coalesce(sum(c.amount_ils), 0) into v_lifetime_charges
  from public.subscription_charges c
  where c.charge_type in ('recurring', 'proration')
    and not exists (select 1 from public.subscription_charges r where r.reverses = c.id);

  select coalesce(sum(a.amount_ils), 0) into v_lifetime_payments
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null;

  return json_build_object(
    'ok', true,
    'active_subscriptions_count', v_active_count,
    'charges_total_ils', v_charges_total,
    'payments_total_ils', v_payments_total,
    'outstanding_ils', v_lifetime_charges - v_lifetime_payments
  );
end;
$$;

comment on function public.manager_subscription_overview_stats(date, date) is
  'Manager-only. Strictly additive Manager Overview metrics for subscriptions: active count (point-in-time), charges/payments total for the requested period, and lifetime outstanding across all subscriptions. Deliberately separate from manager_weekly_stats to avoid touching it; computes directly from subscriptions/subscription_charges/athlete_account_payments with no double-counting against existing Overview fields.';

grant execute on function public.manager_subscription_overview_stats(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'athlete_account_payments'
      and column_name in ('source_subscription_id', 'client_request_id')
    having count(*) = 2
  ) then
    raise exception 'self-check: athlete_account_payments is missing source_subscription_id/client_request_id';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_subscription') <> 1 then
    raise exception 'self-check: create_subscription must have exactly one overload after this migration';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_subscription')
     not like '%p_initial_payment_amount_ils%' then
    raise exception 'self-check: create_subscription was not extended with the initial-payment parameters';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment') <> 1 then
    raise exception 'self-check: record_subscription_payment must exist exactly once';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_stats') <> 1 then
    raise exception 'self-check: manager_subscription_overview_stats must exist exactly once';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'athlete_account_payments_client_request_id_uidx'
  ) then
    raise exception 'self-check: the client_request_id uniqueness guard is missing';
  end if;
end $$;
