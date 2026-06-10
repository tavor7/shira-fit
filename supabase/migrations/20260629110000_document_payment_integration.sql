-- Link document creation to payment recording + session receipt prefill.

create or replace function public._service_type_from_session(p_max int, p_is_kickbox boolean)
returns public.document_service_type
language plpgsql
immutable
as $$
begin
  if coalesce(p_is_kickbox, false) then
    return 'kickboxing';
  end if;
  case coalesce(p_max, 0)
    when 1 then return 'personal';
    when 2 then return 'pair';
    when 3 then return 'trio';
    when 4 then return 'quartet';
    when 5 then return 'quintet';
    when 6 then return 'sextet';
    else return 'group_over_6';
  end case;
end;
$$;

create or replace function public._document_payment_to_session_method(p_method public.document_payment_method)
returns text
language sql
immutable
as $$
  select p_method::text;
$$;

create or replace function public.staff_list_sessions_for_receipts(
  p_date_start date default null,
  p_date_end date default null,
  p_coach_id uuid default null
)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_rows json;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select coalesce(json_agg(row_to_json(t) order by t.session_date desc, t.start_time desc), '[]'::json)
  into v_rows
  from (
    select
      s.id as session_id,
      s.session_date,
      s.start_time,
      s.max_participants,
      coalesce(s.is_kickbox, false) as is_kickbox,
      s.coach_id,
      p.full_name as coach_name,
      (
        select count(*)::int
        from public.session_registrations r
        where r.session_id = s.id and r.status = 'active'
      ) + (
        select count(*)::int
        from public.session_manual_participants m
        where m.session_id = s.id
      ) as roster_count
    from public.training_sessions s
    join public.profiles p on p.user_id = s.coach_id
    where (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)
      and (p_coach_id is null or s.coach_id = p_coach_id)
    order by s.session_date desc, s.start_time desc
    limit 120
  ) t;

  return json_build_object('ok', true, 'sessions', v_rows);
end;
$$;

create or replace function public.staff_session_receipt_roster(p_session_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sess public.training_sessions%rowtype;
  v_coach_name text;
  v_rows json;
  v_service_type public.document_service_type;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select s.* into v_sess
  from public.training_sessions s
  where s.id = p_session_id;

  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  select p.full_name into v_coach_name
  from public.profiles p
  where p.user_id = v_sess.coach_id;

  v_service_type := public._service_type_from_session(v_sess.max_participants, coalesce(v_sess.is_kickbox, false));

  select coalesce(json_agg(row_to_json(x) order by x.full_name), '[]'::json) into v_rows
  from (
    select
      'registered'::text as participant_kind,
      r.id as registration_row_id,
      r.user_id as profile_user_id,
      null::uuid as manual_participant_id,
      pr.full_name,
      pr.phone,
      r.attended,
      r.payment_method as existing_payment_method,
      round(coalesce(r.amount_paid, 0)::numeric, 2) as existing_amount_paid,
      round(coalesce(
        public.session_billing_price_ils(p_session_id, r.user_id, null),
        0
      )::numeric, 2) as suggested_amount_ils,
      v_service_type as service_type,
      exists (
        select 1 from public.documents d
        where d.source_type = 'session_payment'
          and d.source_id = r.id
          and d.status <> 'CANCELLED'
      ) as has_document,
      coalesce(r.amount_paid, 0) > 0 as has_payment
    from public.session_registrations r
    join public.profiles pr on pr.user_id = r.user_id
    where r.session_id = p_session_id and r.status = 'active'

    union all

    select
      'manual'::text,
      m.id,
      null::uuid,
      m.manual_participant_id,
      mp.full_name,
      mp.phone,
      m.attended,
      m.payment_method,
      round(coalesce(m.amount_paid, 0)::numeric, 2),
      round(coalesce(
        public.session_billing_price_ils(p_session_id, null, m.manual_participant_id),
        0
      )::numeric, 2),
      v_service_type,
      exists (
        select 1 from public.documents d
        where d.source_type = 'session_payment'
          and d.source_id = m.id
          and d.status <> 'CANCELLED'
      ),
      coalesce(m.amount_paid, 0) > 0
    from public.session_manual_participants m
    join public.manual_participants mp on mp.id = m.manual_participant_id
    where m.session_id = p_session_id
  ) x;

  return json_build_object(
    'ok', true,
    'session', json_build_object(
      'session_id', v_sess.id,
      'session_date', v_sess.session_date,
      'start_time', v_sess.start_time,
      'max_participants', v_sess.max_participants,
      'is_kickbox', coalesce(v_sess.is_kickbox, false),
      'coach_id', v_sess.coach_id,
      'coach_name', v_coach_name,
      'service_type', v_service_type
    ),
    'roster', v_rows
  );
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
    -- account mode
    if p_profile_user_id is null and p_manual_participant_id is null then
      return json_build_object('ok', false, 'error', 'payee_required');
    end if;

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
    p_profile_user_id, p_manual_participant_id
  );

  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone,
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

grant execute on function public.staff_list_sessions_for_receipts(date, date, uuid) to authenticated;
grant execute on function public.staff_session_receipt_roster(uuid) to authenticated;
grant execute on function public.create_document_with_payment(
  text, numeric, public.document_service_type, public.document_payment_method,
  text, text, text, text, text, uuid, uuid, uuid, date, boolean
) to authenticated;
