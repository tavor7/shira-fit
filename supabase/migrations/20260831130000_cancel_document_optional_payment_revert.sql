-- Cancel currently always reverts the linked payment unconditionally. Make that optional,
-- matching the choice delete_document already offers (p_delete_payment), so staff can cancel
-- a receipt that was issued wrong while keeping the payment record intact, or revert both.
-- Default stays true so existing callers keep today's behavior.
drop function if exists public.cancel_document(uuid, text);

create or replace function public.cancel_document(p_document_id uuid, p_reason text, p_revert_payment boolean default true)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_can_cancel boolean;
  v_payment_result json;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  v_can_cancel := public.is_manager(auth.uid())
    or (public.is_coach_or_manager(auth.uid()) and v_settings.staff_can_cancel_documents);
  if not v_can_cancel then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status = 'CANCELLED' then return json_build_object('ok', false, 'error', 'already_cancelled'); end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then return json_build_object('ok', false, 'error', 'reason_required'); end if;

  update public.documents
  set
    status = 'CANCELLED',
    cancelled_at = now(),
    cancelled_by = auth.uid(),
    cancellation_reason = trim(p_reason),
    pdf_url = null,
    signature_hash = null,
    signature_provider = null,
    signed_at = null
  where id = p_document_id;

  if p_revert_payment then
    v_payment_result := public._revert_document_payment(v_doc.source_type, v_doc.source_id);
  else
    v_payment_result := json_build_object('ok', true, 'reverted', false, 'reason', 'skipped_by_caller');
  end if;

  perform public._log_document_event(
    p_document_id,
    'document_cancelled',
    jsonb_build_object(
      'reason', trim(p_reason),
      'testing_mode', not coalesce(v_settings.is_operational, false),
      'payment_reverted', coalesce((v_payment_result->>'reverted')::boolean, false),
      'payment_revert', v_payment_result::jsonb
    )
  );

  return json_build_object(
    'ok', true,
    'document_id', p_document_id,
    'needs_pdf_reissue', v_doc.pdf_url is not null,
    'payment_reverted', coalesce((v_payment_result->>'reverted')::boolean, false)
  );
end;
$$;
