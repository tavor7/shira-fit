-- Split "request consent from existing users" from operational mode.

alter table public.receipt_settings
  add column if not exists request_consent_from_existing_users boolean not null default false;

comment on column public.receipt_settings.request_consent_from_existing_users is
  'When true, athletes and managers are prompted for electronic receipt consent (independent of operational mode).';

-- Preserve prior behavior for studios already in operational mode.
update public.receipt_settings
set request_consent_from_existing_users = true
where is_operational
  and not request_consent_from_existing_users;

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'document_event_action'
      and e.enumlabel = 'request_consent_setting_changed'
  ) then
    alter type public.document_event_action add value 'request_consent_setting_changed';
  end if;
end;
$$;

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
     or not coalesce(v_settings.request_consent_from_existing_users, false) then
    return json_build_object('ok', true, 'required', v_required);
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;
  if not found or not public._is_receipt_existing_user_profile(v_profile) then
    return json_build_object('ok', true, 'required', v_required);
  end if;

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

create or replace function public.update_receipt_settings(
  p_business_id text default null,
  p_business_name text default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_accountant_email text default null,
  p_digital_receipts_enabled boolean default null,
  p_vat_rate numeric default null,
  p_document_prefix text default null,
  p_staff_can_cancel_documents boolean default null,
  p_is_operational boolean default null,
  p_request_address_from_existing_users boolean default null,
  p_request_consent_from_existing_users boolean default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.receipt_settings%rowtype;
  v_new public.receipt_settings%rowtype;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_old from public.receipt_settings where id = '00000000-0000-4000-8000-000000000001'::uuid for update;
  update public.receipt_settings
  set
    business_id = coalesce(nullif(trim(p_business_id), ''), business_id),
    business_name = coalesce(nullif(trim(p_business_name), ''), business_name),
    address = coalesce(nullif(trim(p_address), ''), address),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    email = coalesce(nullif(trim(p_email), ''), email),
    accountant_email = coalesce(nullif(trim(p_accountant_email), ''), accountant_email),
    digital_receipts_enabled = coalesce(p_digital_receipts_enabled, digital_receipts_enabled),
    vat_rate = coalesce(p_vat_rate, vat_rate),
    document_prefix = coalesce(p_document_prefix, document_prefix),
    staff_can_cancel_documents = coalesce(p_staff_can_cancel_documents, staff_can_cancel_documents),
    is_operational = coalesce(p_is_operational, is_operational),
    request_address_from_existing_users = coalesce(
      p_request_address_from_existing_users,
      request_address_from_existing_users
    ),
    request_consent_from_existing_users = coalesce(
      p_request_consent_from_existing_users,
      request_consent_from_existing_users
    ),
    updated_by = auth.uid(),
    updated_at = now()
  where id = v_old.id
  returning * into v_new;

  if v_old.vat_rate is distinct from v_new.vat_rate then
    perform public._log_document_event(
      null,
      'vat_rate_updated',
      jsonb_build_object('old_rate', v_old.vat_rate, 'new_rate', v_new.vat_rate)
    );
  end if;
  if v_old.is_operational is distinct from v_new.is_operational then
    perform public._log_document_event(
      null,
      'operational_mode_changed',
      jsonb_build_object('is_operational', v_new.is_operational)
    );
  end if;
  if v_old.request_address_from_existing_users is distinct from v_new.request_address_from_existing_users then
    perform public._log_document_event(
      null,
      'request_address_setting_changed',
      jsonb_build_object('enabled', v_new.request_address_from_existing_users)
    );
  end if;
  if v_old.request_consent_from_existing_users is distinct from v_new.request_consent_from_existing_users then
    perform public._log_document_event(
      null,
      'request_consent_setting_changed',
      jsonb_build_object('enabled', v_new.request_consent_from_existing_users)
    );
  end if;

  return json_build_object('ok', true, 'settings', row_to_json(v_new));
end;
$$;

grant execute on function public.update_receipt_settings(
  text, text, text, text, text, text, boolean, numeric, text, boolean, boolean, boolean, boolean
) to authenticated;
