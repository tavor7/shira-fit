-- The receipt PDF only showed the document's created_at (when the row was generated),
-- not when the payment was actually received. Add a paid_at date to documents and
-- populate it from the actual payment date where one exists (account_payment mode
-- already collects this via p_paid_at), falling back to "today" everywhere else so
-- existing rows/flows keep working.

alter table public.documents
  add column if not exists paid_at date;

update public.documents set paid_at = created_at::date where paid_at is null;

create or replace function public.create_document(
  p_gross_amount numeric,
  p_service_type public.document_service_type,
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_payment_method public.document_payment_method default null,
  p_service_description text default null,
  p_notes text default null,
  p_profile_user_id uuid default null,
  p_manual_participant_id uuid default null,
  p_source_type public.document_source_type default 'manual',
  p_source_id uuid default null,
  p_source_payment_method text default null
)
returns json
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12,2);
  v_vat numeric(12,2);
  v_method public.document_payment_method;
  v_status public.document_status;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_customer_email text;
  v_paid_at date;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then return json_build_object('ok', false, 'error', 'digital_receipts_disabled'); end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then return json_build_object('ok', false, 'error', 'business_id_required'); end if;
  if p_gross_amount is null or p_gross_amount <= 0 then return json_build_object('ok', false, 'error', 'invalid_amount'); end if;
  v_method := p_payment_method;
  if v_method is null and p_source_payment_method is not null then
    v_method := public._map_session_payment_to_document_method(p_source_payment_method);
  end if;
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;
  select net_amount, vat_amount into v_net, v_vat from public._document_vat_breakdown(p_gross_amount, v_settings.vat_rate);

  if p_source_type = 'account_payment' and p_source_id is not null then
    select paid_at into v_paid_at from public.athlete_account_payments where id = p_source_id;
  end if;
  v_paid_at := coalesce(v_paid_at, (timezone('Asia/Jerusalem', now()))::date);

  if p_profile_user_id is not null then
    select coalesce(p.address, ''), coalesce(p.zip_code, '')
    into v_customer_address, v_customer_zip
    from public.profiles p where p.user_id = p_profile_user_id;
  end if;

  v_customer_email := public._resolve_customer_email(p_profile_user_id, p_customer_email);

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, v_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );
  v_doc_number := public._allocate_document_number();
  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by, paid_at
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_settings.vat_rate,
    v_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    v_customer_email, nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    p_source_type, p_source_id, auth.uid(), v_paid_at
  ) returning id into v_doc_id;
  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object('document_number', v_doc_number, 'gross_amount', p_gross_amount));
  return json_build_object('ok', true, 'document_id', v_doc_id, 'document_number', v_doc_number, 'status', v_status, 'needs_pdf', true);
end;
$$;

create or replace function public.create_document_with_payment(
  p_mode text,
  p_gross_amount numeric,
  p_service_type public.document_service_type,
  p_payment_method public.document_payment_method,
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_service_description text default null,
  p_notes text default null,
  p_profile_user_id uuid default null,
  p_manual_participant_id uuid default null,
  p_session_id uuid default null,
  p_paid_at date default null,
  p_record_payment boolean default true
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12, 2);
  v_vat numeric(12, 2);
  v_status public.document_status;
  v_source_type public.document_source_type;
  v_source_id uuid;
  v_session_method text;
  v_reg_id uuid;
  v_manual_row_id uuid;
  v_payment_id uuid;
  v_att json;
  v_existing_doc uuid;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_customer_email text;
  v_paid_at date;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_mode not in ('session', 'account') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;
  if p_gross_amount is null or p_gross_amount <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_payment_method is null then
    return json_build_object('ok', false, 'error', 'payment_method_required');
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then
    return json_build_object('ok', false, 'error', 'digital_receipts_disabled');
  end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then
    return json_build_object('ok', false, 'error', 'business_id_required');
  end if;

  if p_profile_user_id is not null then
    select coalesce(p.address, ''), coalesce(p.zip_code, '')
    into v_customer_address, v_customer_zip
    from public.profiles p where p.user_id = p_profile_user_id;
  end if;

  v_session_method := public._document_payment_to_session_method(p_payment_method);
  v_status := 'ACTIVE';
  v_paid_at := coalesce(p_paid_at, (timezone('Asia/Jerusalem', now()))::date);

  if p_mode = 'session' then
    if p_session_id is null then
      return json_build_object('ok', false, 'error', 'session_id_required');
    end if;

    if p_profile_user_id is not null then
      select r.id into v_reg_id
      from public.session_registrations r
      where r.session_id = p_session_id and r.user_id = p_profile_user_id and r.status = 'active';
      if not found then
        return json_build_object('ok', false, 'error', 'not_on_roster');
      end if;

      select d.id into v_existing_doc
      from public.documents d
      where d.source_type = 'session_payment' and d.source_id = v_reg_id and d.status <> 'CANCELLED'
      limit 1;
      if v_existing_doc is not null then
        return json_build_object('ok', false, 'error', 'document_already_exists', 'document_id', v_existing_doc);
      end if;

      if p_record_payment then
        v_att := public.set_registration_attendance(
          p_session_id, p_profile_user_id, 'arrived', v_session_method, p_gross_amount, false
        );
        if coalesce((v_att->>'ok')::boolean, false) is not true then
          return v_att;
        end if;
      end if;

      v_source_type := 'session_payment';
      v_source_id := v_reg_id;

    elsif p_manual_participant_id is not null then
      select m.id into v_manual_row_id
      from public.session_manual_participants m
      where m.session_id = p_session_id and m.manual_participant_id = p_manual_participant_id;
      if not found then
        return json_build_object('ok', false, 'error', 'not_on_roster');
      end if;

      select d.id into v_existing_doc
      from public.documents d
      where d.source_type = 'session_payment' and d.source_id = v_manual_row_id and d.status <> 'CANCELLED'
      limit 1;
      if v_existing_doc is not null then
        return json_build_object('ok', false, 'error', 'document_already_exists', 'document_id', v_existing_doc);
      end if;

      if p_record_payment then
        v_att := public.set_manual_participant_attendance(
          p_session_id, p_manual_participant_id, 'arrived', v_session_method, p_gross_amount, false
        );
        if coalesce((v_att->>'ok')::boolean, false) is not true then
          return v_att;
        end if;
      end if;

      v_source_type := 'session_payment';
      v_source_id := v_manual_row_id;
    else
      return json_build_object('ok', false, 'error', 'payee_required');
    end if;
  else
    insert into public.athlete_account_payments (
      payee_id,
      payee_is_manual,
      amount_ils,
      payment_method,
      note,
      paid_at
    )
    values (
      coalesce(p_profile_user_id, p_manual_participant_id),
      p_manual_participant_id is not null,
      p_gross_amount,
      v_session_method,
      nullif(trim(coalesce(p_notes, '')), ''),
      v_paid_at
    )
    returning id into v_payment_id;

    v_source_type := 'account_payment';
    v_source_id := v_payment_id;
  end if;

  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(p_gross_amount, v_settings.vat_rate);

  v_customer_email := public._resolve_customer_email(p_profile_user_id, p_customer_email);

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, v_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );

  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by, paid_at
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_settings.vat_rate,
    p_payment_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    v_customer_email, nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    v_source_type, v_source_id, auth.uid(), v_paid_at
  ) returning id into v_doc_id;

  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object(
    'document_number', v_doc_number,
    'gross_amount', p_gross_amount,
    'mode', p_mode,
    'source_type', v_source_type,
    'source_id', v_source_id
  ));

  return json_build_object(
    'ok', true,
    'document_id', v_doc_id,
    'document_number', v_doc_number,
    'status', v_status,
    'needs_pdf', true,
    'source_type', v_source_type,
    'source_id', v_source_id,
    'payment_recorded', p_record_payment or p_mode = 'account'
  );
end;
$$;
