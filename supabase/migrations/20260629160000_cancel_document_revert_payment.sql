-- When voiding a receipt in testing mode, also remove the linked payment record.

create or replace function public._revert_document_payment(
  p_source_type public.document_source_type,
  p_source_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_source_id is null or p_source_type is null or p_source_type = 'manual' then
    return json_build_object('ok', true, 'reverted', false, 'reason', 'no_linked_payment');
  end if;

  case p_source_type
    when 'account_payment' then
      delete from public.athlete_account_payments where id = p_source_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'account_payment');

    when 'session_payment' then
      update public.session_registrations
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'registration');
      end if;

      update public.session_manual_participants
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'manual');
      end if;
      return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');

    when 'cancellation_penalty' then
      update public.cancellations
      set penalty_collected_ils = 0
      where id = p_source_id
        and coalesce(penalty_collected_ils, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'cancellation_penalty');

    else
      return json_build_object('ok', true, 'reverted', false, 'reason', 'unsupported_source');
  end case;
end;
$$;

create or replace function public.cancel_document(p_document_id uuid, p_reason text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_can_cancel boolean;
  v_payment_result json;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_settings from public.receipt_settings limit 1;

  if coalesce(v_settings.is_operational, false) then
    return json_build_object('ok', false, 'error', 'operational_mode_locked');
  end if;

  v_can_cancel := public.is_manager(auth.uid())
    or (public.is_coach_or_manager(auth.uid()) and v_settings.staff_can_cancel_documents);

  if not v_can_cancel then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_doc.status = 'CANCELLED' then
    return json_build_object('ok', false, 'error', 'already_cancelled');
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;

  update public.documents
  set
    status = 'CANCELLED',
    cancelled_at = now(),
    cancelled_by = auth.uid(),
    cancellation_reason = trim(p_reason)
  where id = p_document_id;

  v_payment_result := public._revert_document_payment(v_doc.source_type, v_doc.source_id);

  perform public._log_document_event(
    p_document_id,
    'document_cancelled',
    jsonb_build_object(
      'reason', trim(p_reason),
      'testing_mode', true,
      'payment_reverted', coalesce((v_payment_result->>'reverted')::boolean, false),
      'payment_revert', v_payment_result::jsonb
    )
  );

  return json_build_object(
    'ok', true,
    'document_id', p_document_id,
    'payment_reverted', coalesce((v_payment_result->>'reverted')::boolean, false)
  );
end;
$$;

comment on function public._revert_document_payment(public.document_source_type, uuid) is
  'Testing-mode helper: removes payment linked to a voided receipt (account row delete, session payment clear, penalty zero).';
