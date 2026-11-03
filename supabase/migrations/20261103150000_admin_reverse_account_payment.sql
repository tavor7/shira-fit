-- A server-side way to reverse a mistaken account payment when no manager is signed in, such as an owner-authorised
-- correction carried out by an operator. manager_reverse_account_payment needs a signed-in manager, and a database
-- connection has none. No user identity is created or assumed here.
--
-- Client roles cannot call this, and it refuses to run inside a user session. It has the same refusals as the manager
-- function, and also checks the expected amount and date, so a wrong id or a changed row stops it.
--
-- Who is recorded: the activity event has no actor, because no signed-in user acted, and its details name who performed it
-- and which manager authorised it. reversed_by must be a real profile (athlete_account_payments_reversed_pair_chk), so it
-- holds the authorising manager.

create or replace function public.admin_reverse_account_payment(
  p_payment_id uuid,
  p_reason text,
  p_authorized_by uuid,
  p_performed_by text,
  p_expected_amount numeric,
  p_expected_paid_at date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_performed_by text := trim(coalesce(p_performed_by, ''));
  v_pay public.athlete_account_payments%rowtype;
begin
  if auth.uid() is not null then return jsonb_build_object('ok', false, 'error', 'not_for_user_sessions'); end if;
  if char_length(v_reason) < 3 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  if char_length(v_performed_by) < 3 then return jsonb_build_object('ok', false, 'error', 'performed_by_required'); end if;
  if p_authorized_by is null or not public.is_manager(p_authorized_by) then
    return jsonb_build_object('ok', false, 'error', 'authorizer_not_manager');
  end if;

  select * into v_pay from public.athlete_account_payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_pay.amount_ils is distinct from p_expected_amount or v_pay.paid_at is distinct from p_expected_paid_at then
    return jsonb_build_object('ok', false, 'error', 'payment_does_not_match');
  end if;
  if v_pay.reversed_at is not null then return jsonb_build_object('ok', false, 'error', 'already_reversed'); end if;
  if v_pay.source_subscription_id is not null then return jsonb_build_object('ok', false, 'error', 'linked_to_subscription'); end if;
  if public._payment_has_any_document('account', v_pay.id) then
    return jsonb_build_object('ok', false, 'error', 'has_receipt_history');
  end if;

  -- The switch _guard_receipted_account_payment checks, local to this transaction and turned straight back off.
  perform set_config('shira.allow_payment_reversal', 'on', true);
  update public.athlete_account_payments
  set reversed_at = now(), reversed_by = p_authorized_by
  where id = v_pay.id;
  perform set_config('shira.allow_payment_reversal', 'off', true);

  perform public._insert_activity_event(
    null, 'account_payment_reversed', 'athlete_account_payment', v_pay.id::text,
    jsonb_build_object(
      'payee_id', v_pay.payee_id,
      'payee_is_manual', v_pay.payee_is_manual,
      'amount_ils', v_pay.amount_ils,
      'payment_method', v_pay.payment_method,
      'paid_at', v_pay.paid_at,
      'reason', v_reason,
      'performed_by', v_performed_by,
      'authorized_by', p_authorized_by
    )
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.admin_reverse_account_payment(uuid, text, uuid, text, numeric, date) from public, anon, authenticated, service_role;

comment on function public.admin_reverse_account_payment(uuid, text, uuid, text, numeric, date) is
  'Operator-run reversal of a mistaken account payment, authorised by a named manager. Not callable by any client or API role.';
