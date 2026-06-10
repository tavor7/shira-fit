-- Customer mailing address + zip on profiles, customers, and document snapshots.

alter table public.profiles
  add column if not exists address text not null default '',
  add column if not exists zip_code text not null default '';

alter table public.customers
  add column if not exists address text not null default '',
  add column if not exists zip_code text not null default '';

alter table public.documents
  add column if not exists customer_address text not null default '',
  add column if not exists customer_zip_code text not null default '';

create or replace function public._upsert_customer_from_payee(
  p_name text,
  p_email text,
  p_phone text,
  p_profile_user_id uuid,
  p_manual_participant_id uuid,
  p_address text default '',
  p_zip_code text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_profile_user_id is not null then
    select c.id into v_id from public.customers c where c.profile_user_id = p_profile_user_id limit 1;
  elsif p_manual_participant_id is not null then
    select c.id into v_id from public.customers c where c.manual_participant_id = p_manual_participant_id limit 1;
  end if;

  if v_id is not null then
    update public.customers
    set
      name = coalesce(nullif(trim(p_name), ''), name),
      email = coalesce(nullif(trim(p_email), ''), email),
      phone = coalesce(nullif(trim(p_phone), ''), phone),
      address = coalesce(nullif(trim(p_address), ''), address),
      zip_code = coalesce(nullif(trim(p_zip_code), ''), zip_code),
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  insert into public.customers (name, email, phone, address, zip_code, profile_user_id, manual_participant_id)
  values (
    coalesce(nullif(trim(p_name), ''), 'לקוח'),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    coalesce(nullif(trim(p_address), ''), ''),
    coalesce(nullif(trim(p_zip_code), ''), ''),
    p_profile_user_id,
    p_manual_participant_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

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
language plpgsql security definer set search_path = public
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_customer_id uuid; v_doc_id uuid; v_doc_number text;
  v_net numeric(12,2); v_vat numeric(12,2);
  v_method public.document_payment_method;
  v_status public.document_status;
  v_customer_address text := '';
  v_customer_zip text := '';
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

  if p_profile_user_id is not null then
    select coalesce(p.address, ''), coalesce(p.zip_code, '')
    into v_customer_address, v_customer_zip
    from public.profiles p where p.user_id = p_profile_user_id;
  end if;

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, p_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );
  v_doc_number := public._allocate_document_number();
  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_settings.vat_rate,
    v_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    nullif(trim(coalesce(p_customer_email, '')), ''), nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    p_source_type, p_source_id, auth.uid()
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
set search_path = public
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
      coalesce(p_paid_at, (timezone('Asia/Jerusalem', now()))::date)
    )
    returning id into v_payment_id;

    v_source_type := 'account_payment';
    v_source_id := v_payment_id;
  end if;

  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(p_gross_amount, v_settings.vat_rate);

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, p_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );

  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by
  )
  values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_settings.vat_rate,
    p_payment_method, p_service_type,
    nullif(trim(coalesce(p_service_description, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_status,
    coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    nullif(trim(coalesce(p_customer_email, '')), ''),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address,
    v_settings.phone, v_settings.email,
    v_source_type, v_source_id, auth.uid()
  )
  returning id into v_doc_id;

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

-- Pending-receipt path: snapshot profile address on document create.
create or replace function public._create_document_from_payment_row(p_row_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_row record;
  v_source public.document_source_type;
  v_source_id uuid;
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12, 2);
  v_vat numeric(12, 2);
  v_method public.document_payment_method;
  v_status public.document_status;
  v_service_type public.document_service_type;
  v_service_description text;
  v_profile_user_id uuid;
  v_manual_participant_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_amount numeric(12, 2);
begin
  select * into v_row
  from (
    select
      'account'::text as row_kind,
      ('account:' || a.id::text) as row_id,
      a.id as record_id,
      a.payee_id,
      a.payee_is_manual,
      round(a.amount_ils::numeric, 2) as amount_ils,
      a.payment_method,
      a.note,
      null::uuid as session_id,
      null::date as session_date,
      null::time as session_start_time,
      null::text as session_slot_kind,
      null::int as max_participants,
      false as is_kickbox,
      null::text as coach_name
    from public.athlete_account_payments a
    union all
    select
      'registration'::text,
      ('registration:' || r.id::text),
      r.id,
      r.user_id,
      false,
      round(coalesce(r.payment_amount_ils, 0)::numeric, 2),
      r.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      'attendance'::text,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    left join public.profiles cp on cp.user_id = s.coach_id
    where r.status = 'active'
      and r.payment_method is not null
      and coalesce(r.payment_amount_ils, 0) > 0
    union all
    select
      'manual'::text,
      ('manual:' || m.id::text),
      m.id,
      m.manual_participant_id,
      true,
      round(coalesce(m.payment_amount_ils, 0)::numeric, 2),
      m.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      coalesce(m.slot_kind, 'attendance'),
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.profiles cp on cp.user_id = s.coach_id
    where m.payment_method is not null
      and coalesce(m.payment_amount_ils, 0) > 0
  ) q
  where q.row_id = p_row_id;

  if not found then
    return json_build_object('ok', false, 'error', 'not_found', 'row_id', p_row_id);
  end if;

  if public._payment_has_active_document(v_row.row_kind, v_row.record_id) then
    return json_build_object('ok', false, 'error', 'document_already_exists', 'row_id', p_row_id);
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then
    return json_build_object('ok', false, 'error', 'digital_receipts_disabled');
  end if;

  v_source := public._payment_document_source_type(v_row.row_kind);
  v_source_id := v_row.record_id;
  v_method := public._map_session_payment_to_document_method(v_row.payment_method);
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;

  if v_row.row_kind = 'account' then
    v_service_type := 'other';
    v_service_description := coalesce(nullif(trim(v_row.note), ''), 'תשלום חשבון');
  else
    v_service_type := public._service_type_from_session(v_row.max_participants, v_row.is_kickbox);
    v_service_description := trim(both ' ·' from concat_ws(
      ' · ',
      v_row.coach_name,
      to_char(v_row.session_date, 'DD/MM/YYYY'),
      case v_row.session_slot_kind
        when 'no_show' then 'אי הגעה'
        when 'cancellation' then 'ביטול מאוחר'
        else null
      end
    ));
  end if;

  if v_row.payee_is_manual then
    v_manual_participant_id := v_row.payee_id;
    v_profile_user_id := null;
  else
    v_profile_user_id := v_row.payee_id;
    v_manual_participant_id := null;
  end if;

  v_amount := v_row.amount_ils;

  select coalesce(p.full_name, m.full_name, 'לקוח'), coalesce(p.phone, m.phone),
         coalesce(p.address, ''), coalesce(p.zip_code, '')
  into v_customer_name, v_customer_phone, v_customer_address, v_customer_zip
  from (select 1) x
  left join public.profiles p on p.user_id = v_profile_user_id
  left join public.manual_participants m on m.id = v_manual_participant_id;

  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(v_amount, v_settings.vat_rate);

  v_customer_id := public._upsert_customer_from_payee(
    v_customer_name, null, v_customer_phone,
    v_profile_user_id, v_manual_participant_id,
    v_customer_address, v_customer_zip
  );
  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by
  )
  values (
    v_doc_number, v_customer_id, v_amount, v_net, v_vat, v_settings.vat_rate,
    v_method, v_service_type, v_service_description, null,
    v_status, v_customer_name, null, v_customer_phone,
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address,
    v_settings.phone, v_settings.email,
    v_source, v_source_id, auth.uid()
  )
  returning id into v_doc_id;

  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object(
    'document_number', v_doc_number,
    'gross_amount', v_amount,
    'row_id', p_row_id,
    'source_type', v_source,
    'source_id', v_source_id
  ));

  return json_build_object(
    'ok', true,
    'row_id', p_row_id,
    'document_id', v_doc_id,
    'document_number', v_doc_number,
    'status', v_status,
    'needs_pdf', true
  );
exception
  when others then
    return json_build_object('ok', false, 'error', SQLERRM, 'row_id', p_row_id);
end;
$$;
