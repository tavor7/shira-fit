-- Refresh business snapshot from receipt_settings when preparing PDF regeneration.

create or replace function public.prepare_document_pdf_regeneration(p_document_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_settings public.receipt_settings%rowtype;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if v_settings.is_operational then
    return json_build_object('ok', false, 'error', 'operational_mode_locked');
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_doc.status = 'NEEDS_PAYMENT_METHOD' then
    return json_build_object('ok', false, 'error', 'needs_payment_method');
  end if;

  update public.documents
  set
    pdf_url = null,
    signature_hash = null,
    signature_provider = null,
    signed_at = null,
    business_name = v_settings.business_name,
    business_id = v_settings.business_id,
    business_address = v_settings.address,
    business_phone = v_settings.phone,
    business_email = coalesce(v_settings.email, '')
  where id = p_document_id;

  perform public._log_document_event(p_document_id, 'document_pdf_regenerated', '{}'::jsonb);

  return json_build_object('ok', true, 'document_id', p_document_id, 'allow_overwrite', true);
end;
$$;
