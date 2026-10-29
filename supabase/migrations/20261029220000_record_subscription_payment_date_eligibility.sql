-- Harden record_subscription_payment: reject attributing a payment to a subscription that was
-- not active (stopped or already completed) as of the payment's own paid_at date.
--
-- Previously the only check was that the subscription row exists at all (and, since
-- 20261026100000, is not deleted) -- a payment could still be linked to a subscription dated
-- after it had already stopped or run past its plan_end_date. The new AddAccountPaymentModal
-- "this is a subscription payment" toggle (mobile) now determines client-side whether to even
-- offer the option using the same rule; this migration is the server-side half of that check, so
-- UI visibility is never the only protection (a client that skips the check, or a stale UI state,
-- still gets refused here).
--
-- Rule: find the version effective at paid_at (its [effective_from, effective_to) window
-- contains paid_at, same ordering as subscription_effective_context); if none covers paid_at but
-- the subscription hasn't started yet as of that date (paid_at before its earliest version's
-- effective_from), fall back to that earliest version instead -- an advance payment against a
-- not-yet-started subscription is a legitimate, already-relied-upon case (see
-- 189_subscription_delete_payment_guard_tests.sh scenarios 3/4), not "no longer active". Whichever
-- version is selected, refuse (subscription_not_eligible_for_date) if it is stopped
-- (stopped_effective_date <= paid_at) or past its plan_end_date; refuse the same way if no version
-- at all covers or precedes paid_at (the subscription had already fully ended by then). A frozen
-- subscription is still eligible -- a freeze pauses billing/coverage, it does not end the
-- relationship, and a manager may still legitimately record a payment against it (e.g. settling a
-- balance from before the freeze).
--
-- IMPORTANT: this function was already modified once since its original definition (migration
-- 20261026100000_subscription_delete_payment_guard.sql added the subscription_admin_lock_key
-- advisory lock and the subscription_deleted guard, to close a race with delete_subscription).
-- This migration is written against that CURRENT body, preserving both -- not the original,
-- pre-20261026100000 one.

do $$
begin
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment')
     not like '%subscription_admin_lock_key%' then
    raise exception 'precondition: record_subscription_payment must already have the 20261026100000 advisory-lock/deleted-guard body before this migration layers the date-eligibility check on top';
  end if;
end $$;

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
  v_ver record;
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

  -- Date-eligibility check. First, the version actually effective at paid_at, if any.
  select v.* into v_ver
  from public.subscription_versions v
  where v.subscription_id = v_sub.id
    and v.effective_from <= v_paid_at
    and (v.effective_to is null or v.effective_to > v_paid_at)
  order by v.effective_from desc
  limit 1;

  if not found then
    -- No version covers paid_at. If paid_at is before the subscription has even started
    -- (effective_from in the future relative to paid_at), this is a legitimate advance payment --
    -- not stopped, not completed, just not started yet as of that date (an established, already-
    -- relied-upon case: record_subscription_payment is called with no payment date, i.e. today,
    -- against a subscription whose plan_start_date is in the future -- see
    -- 189_subscription_delete_payment_guard_tests.sh scenarios 3/4). Fall back to the EARLIEST
    -- version so a stop applied in advance (unusual but representable) still correctly blocks it.
    select v.* into v_ver
    from public.subscription_versions v
    where v.subscription_id = v_sub.id
      and v.effective_from > v_paid_at
    order by v.effective_from asc
    limit 1;

    if not found then
      -- paid_at is after every version's window: the subscription had already fully ended by
      -- paid_at with nothing covering it. Genuinely ineligible.
      return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
    end if;
  end if;

  if v_ver.stopped_effective_date is not null and v_paid_at >= v_ver.stopped_effective_date then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
  end if;

  if v_ver.plan_end_date is not null and v_paid_at > v_ver.plan_end_date then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
  end if;

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
  'Manager-only. Records a payment against an existing subscription as an ordinary athlete_account_payments row tagged with source_subscription_id -- no receipt is issued automatically. Takes subscription_admin_lock_key before touching the subscription so it can never race delete_subscription; refuses (subscription_deleted) against an already-deleted subscription. Refuses (subscription_not_eligible_for_date) if, as of paid_at, the subscription had already stopped or run past its plan_end_date, or had no version yet at all; an advance payment against a not-yet-started (scheduled) subscription is allowed, and so is one against a frozen version. Idempotent via p_client_request_id: a retry with the same token returns the already-recorded payment rather than duplicating it.';

-- Self-check: both the pre-existing lock/deleted-guard and the new date-eligibility check must be
-- present in the function actually left behind by this migration.
do $$
begin
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment')
     not like '%subscription_admin_lock_key%' then
    raise exception 'self-check: record_subscription_payment lost the 20261026100000 advisory lock';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment')
     not like '%subscription_deleted%' then
    raise exception 'self-check: record_subscription_payment lost the 20261026100000 deleted-subscription guard';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_subscription_payment')
     not like '%subscription_not_eligible_for_date%' then
    raise exception 'self-check: record_subscription_payment was not updated with the date-eligibility check';
  end if;
end $$;
