-- Only prompt existing users for receipt consent + address after go-live (operational mode).

create or replace function public.get_required_consents()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_doc public.legal_documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_required jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not coalesce(v_settings.digital_receipts_enabled, false)
     or not coalesce(v_settings.is_operational, false) then
    return json_build_object('ok', true, 'required', v_required);
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;
  select * into v_doc
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current
  limit 1;

  if v_doc.id is not null
     and (v_profile.electronic_receipts_consent_version is null
          or v_profile.electronic_receipts_consent_version < v_doc.version) then
    v_required := v_required || jsonb_build_array(
      jsonb_build_object(
        'consent_type', v_doc.consent_type,
        'version', v_doc.version,
        'title', v_doc.title,
        'body_text', v_doc.body_text
      )
    );
  end if;

  return json_build_object('ok', true, 'required', v_required);
end;
$$;
