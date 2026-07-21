-- Let managers set the starting/next document number while still in testing mode
-- (document_prefix was already editable; next_document_number had no way to change it).

-- Adding a parameter creates a new overload in Postgres rather than replacing the old
-- signature in place, so drop the previous 13-arg version first to avoid ambiguity.
drop function if exists public.update_receipt_settings(
  text, text, text, text, text, text, boolean, numeric, text, boolean, boolean, boolean, boolean
);

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
  p_request_consent_from_existing_users boolean default null,
  p_next_document_number bigint default null
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

  if p_next_document_number is not null then
    if v_old.is_operational then
      return json_build_object('ok', false, 'error', 'cannot_change_number_while_operational');
    end if;
    if p_next_document_number < 1 then
      return json_build_object('ok', false, 'error', 'invalid_next_document_number');
    end if;
  end if;

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
    next_document_number = coalesce(p_next_document_number, next_document_number),
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
  text, text, text, text, text, text, boolean, numeric, text, boolean, boolean, boolean, boolean, bigint
) to authenticated;
