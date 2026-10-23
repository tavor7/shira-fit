-- Owner-approved policy change: a subscription with any valid (unreversed) payment attributed to
-- it -- even a partial one -- must NOT be deletable. delete_subscription previously was a pure
-- tombstone that never looked at payments and never reversed charges (see its original comment in
-- 20260924150000_subscriptions_management_backend.sql), which left permanently unpaid charges on
-- deleted subscriptions counted forever as outstanding debt in manager_subscription_overview_stats
-- and as expected-debt line items in _period_merged_athlete_finance ("From Athletes"). Production
-- audit found exactly this: four deleted subscriptions, zero payments against any of them, summing
-- to the unexplained ₪960 outstanding figure (handled by a separate backfill migration, not this one).
--
-- New rule, enforced here at the RPC/database level (not just the UI):
--   - If the subscription has any unreversed payment (athlete_account_payments.source_subscription_id
--     = this subscription, reversed_at is null) -> block deletion entirely. No charges, no payments,
--     no subscription row are touched. Caller gets a machine-readable error code so the UI can show a
--     localized message and suggest stop_subscription instead.
--   - Otherwise -> reverse every currently-effective (unreversed) subscription_charges row for this
--     subscription (whatever its charge_type -- recurring, proration, freeze_credit, stop_proration,
--     edit_correction), via the same append-only `reversal` + `reverses` pattern every other
--     correction path already uses, then tombstone as before. The original charge rows are never
--     altered or deleted -- only new reversal rows are appended, fully auditable.
--   - Idempotent: calling delete on an already-deleted subscription is a no-op ('already_deleted'),
--     it never re-reverses anything.
--
-- Concurrency: record_subscription_payment did not previously take subscription_admin_lock_key, so a
-- payment recorded concurrently with a delete call was a race (the delete's "no payments" check could
-- run before the payment commits, then the payment commits after, leaving a deleted subscription with
-- a live payment attached). Fixed by taking the same per-subscription advisory xact lock there too --
-- the lock is already used by create/freeze/stop/edit/delete, so this closes the last gap. Because
-- pg_advisory_xact_lock blocks until the other transaction holding the same key commits or rolls back,
-- whichever of {record_subscription_payment, delete_subscription} commits first is authoritative for
-- what the other one then observes.

-- ---------------------------------------------------------------------------
-- 0. Preconditions: refuse to run if either function's source has drifted from what this migration
--    was written against, so an unreviewed concurrent change to either isn't silently clobbered.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_subscription') <> 1 then
    raise exception 'precondition: delete_subscription must have exactly one overload';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment') <> 1 then
    raise exception 'precondition: record_subscription_payment must have exactly one overload';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_subscription') like '%source_subscription_id%' then
    raise exception 'precondition: delete_subscription already references source_subscription_id -- this migration may already be applied or the function has changed unexpectedly';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. record_subscription_payment: take the per-subscription advisory lock before doing anything
--    else, so it can never race delete_subscription for the same subscription id.
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
  -- existing payment rather than erroring or duplicating. Checked before the lock -- a pure read
  -- against a unique index, no race with delete_subscription to serialize against yet.
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

  -- Same advisory lock delete_subscription takes, keyed by subscription id: whichever of the two
  -- calls commits first is authoritative for what the other observes once it proceeds past here.
  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select s.id, s.payee_id, s.payee_is_manual, s.deleted_at into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;
  if v_sub.deleted_at is not null then
    return json_build_object('ok', false, 'error', 'subscription_deleted');
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
  'Manager-only. Records a payment against an existing subscription as an ordinary athlete_account_payments row tagged with source_subscription_id -- no receipt is issued automatically. Idempotent via p_client_request_id. Takes subscription_admin_lock_key before touching the subscription so it can never race delete_subscription (2026-10-26: a subscription with any valid payment can no longer be deleted, so this lock is what makes that rule atomic). Refuses to record against an already-deleted subscription.';

-- ---------------------------------------------------------------------------
-- 2. delete_subscription: block if any valid (unreversed) payment exists; otherwise reverse every
--    remaining effective charge, then tombstone. Idempotent against repeated calls.
-- ---------------------------------------------------------------------------

create or replace function public.delete_subscription(p_subscription_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_has_payment boolean;
  v_source_id uuid;
  v_reversed_count int := 0;
  v_reversed_total numeric(12, 2) := 0;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select deleted_at into v_deleted_at
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Idempotent no-op: never re-check payments or re-reverse charges on a repeated call.
  if v_deleted_at is not null then
    return json_build_object('ok', true, 'action', 'already_deleted');
  end if;

  -- The owner-approved rule: ANY valid (unreversed) payment -- including a partial one -- blocks
  -- deletion outright. Nothing is modified when this fires: no charge touched, no payment touched,
  -- the subscription itself untouched. The caller should offer stop_subscription instead.
  select exists (
    select 1 from public.athlete_account_payments a
    where a.source_subscription_id = p_subscription_id
      and a.reversed_at is null
  ) into v_has_payment;

  if v_has_payment then
    return json_build_object('ok', false, 'error', 'subscription_has_payments');
  end if;

  v_source_id := gen_random_uuid();

  -- Reverse every currently-effective charge (any charge_type -- recurring, proration,
  -- freeze_credit, stop_proration, edit_correction -- whichever haven't already been reversed by
  -- an earlier stop/freeze/edit correction) so this subscription contributes exactly zero to
  -- outstanding debt everywhere it's read from (manager_subscription_overview_stats,
  -- _period_merged_athlete_finance, get_subscription_detail). The original charge rows are never
  -- altered -- only a new `reversal` row is appended per charge, linked via `reverses`, same
  -- append-only discipline as every other correction path.
  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.subscription_id = p_subscription_id
      and c.charge_type <> 'reversal'
      and not exists (
        select 1 from public.subscription_charges rv
        where rv.charge_type = 'reversal' and rv.reverses = c.id
      )
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id, v_source_id
    );
    v_reversed_count := v_reversed_count + 1;
    v_reversed_total := v_reversed_total + r.amount_ils;
  end loop;

  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  return json_build_object(
    'ok', true, 'action', 'tombstoned',
    'reversed_charge_count', v_reversed_count,
    'reversed_total_ils', v_reversed_total
  );
end;
$$;

comment on function public.delete_subscription(uuid) is
  'Manager-only. Blocks deletion outright (error subscription_has_payments) if any unreversed payment is attributed to this subscription, even a partial one -- per owner policy 2026-10-26, only stop_subscription may be used once any payment has been recorded. Otherwise reverses every remaining effective subscription_charges row (append-only, via a new reversal row per charge) so the subscription contributes zero outstanding debt, then tombstones (deleted_at) -- never a hard DELETE. Idempotent: a repeated call on an already-deleted subscription is a no-op and never re-reverses anything.';

grant execute on function public.delete_subscription(uuid) to authenticated;
grant execute on function public.record_subscription_payment(uuid, numeric, text, text, text, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Self-check.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_subscription') <> 1 then
    raise exception 'self-check: delete_subscription must exist exactly once';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_subscription')
     not like '%subscription_has_payments%' then
    raise exception 'self-check: delete_subscription was not updated with the payment guard';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment')
     not like '%subscription_admin_lock_key%' then
    raise exception 'self-check: record_subscription_payment was not updated to take the advisory lock';
  end if;
end $$;
