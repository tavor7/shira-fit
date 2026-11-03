-- An audited way to cancel an account payment that was entered by mistake, keeping the row.
--
-- A payment with no receipt could only be hard-deleted, and reversed_at could only be set by cancelling a receipt. This
-- marks such a payment reversed, which every financial total already excludes, and writes an activity event with the reason.
-- It refuses a payment with any receipt history or a subscription link: those have their own correction paths.

create or replace function public.manager_reverse_account_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_pay public.athlete_account_payments%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if char_length(v_reason) < 3 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;

  select * into v_pay from public.athlete_account_payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_pay.reversed_at is not null then return jsonb_build_object('ok', false, 'error', 'already_reversed'); end if;
  if v_pay.source_subscription_id is not null then return jsonb_build_object('ok', false, 'error', 'linked_to_subscription'); end if;
  if public._payment_has_any_document('account', v_pay.id) then
    return jsonb_build_object('ok', false, 'error', 'has_receipt_history');
  end if;

  -- The switch _guard_receipted_account_payment checks, local to this transaction and turned straight back off.
  perform set_config('shira.allow_payment_reversal', 'on', true);
  update public.athlete_account_payments
  set reversed_at = now(), reversed_by = v_uid
  where id = v_pay.id;
  perform set_config('shira.allow_payment_reversal', 'off', true);

  perform public._insert_activity_event(
    v_uid, 'account_payment_reversed', 'athlete_account_payment', v_pay.id::text,
    jsonb_build_object(
      'payee_id', v_pay.payee_id,
      'payee_is_manual', v_pay.payee_is_manual,
      'amount_ils', v_pay.amount_ils,
      'payment_method', v_pay.payment_method,
      'paid_at', v_pay.paid_at,
      'reason', v_reason
    )
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.manager_reverse_account_payment(uuid, text) from public, anon;
grant execute on function public.manager_reverse_account_payment(uuid, text) to authenticated;

comment on function public.manager_reverse_account_payment(uuid, text) is
  'Cancels a mistaken account payment with no receipt history or subscription link. Keeps the row and records the reason.';
