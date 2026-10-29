-- Harden record_subscription_payment: reject attributing a payment to a subscription that was
-- not active (stopped or already completed) as of the payment's own paid_at date.
--
-- Previously the only check was that the subscription row exists at all -- a payment could be
-- linked to a subscription dated after it had already stopped or run past its plan_end_date. The
-- new AddAccountPaymentModal "this is a subscription payment" toggle (mobile) now determines
-- client-side whether to even offer the option using the same rule; this migration is the
-- server-side half of that check, so UI visibility is never the only protection (a client that
-- skips the check, or a stale UI state, still gets refused here).
--
-- Rule mirrors subscription_version_display_status's own lifecycle logic for the version
-- effective at paid_at (schema migration 20260924100000, same ordering/window as
-- subscription_effective_context): find the version whose [effective_from, effective_to) window
-- contains paid_at; if none exists, or that version is stopped (stopped_effective_date <=
-- paid_at) or past its plan_end_date, refuse with 'subscription_not_eligible_for_date'. A frozen
-- subscription is still eligible -- a freeze pauses billing/coverage, it does not end the
-- relationship, and a manager may still legitimately record a payment against it (e.g. settling a
-- balance from before the freeze).

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

  -- Date-eligibility check: the subscription must have an effective version covering paid_at,
  -- and that version must not already be stopped or past its plan_end_date as of paid_at.
  select v.* into v_ver
  from public.subscription_versions v
  where v.subscription_id = v_sub.id
    and v.effective_from <= v_paid_at
    and (v.effective_to is null or v.effective_to > v_paid_at)
  order by v.effective_from desc
  limit 1;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
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
  'Manager-only. Records a payment against an existing subscription as an ordinary athlete_account_payments row tagged with source_subscription_id -- no receipt is issued automatically. Refuses (subscription_not_eligible_for_date) if the subscription has no version effective on paid_at, or that version is already stopped or past its plan_end_date as of paid_at (a frozen version is still eligible). Idempotent via p_client_request_id: a retry with the same token returns the already-recorded payment rather than duplicating it.';
