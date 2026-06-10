-- Block voiding receipts once operational mode is on (testing-only revert).

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

  perform public._log_document_event(
    p_document_id,
    'document_cancelled',
    jsonb_build_object('reason', trim(p_reason), 'testing_mode', true)
  );

  return json_build_object('ok', true, 'document_id', p_document_id);
end;
$$;
