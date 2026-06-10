-- Fix pending-receipts RPCs: avoid record-returning function in FROM (PG requires column list).

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

create or replace function public._payment_document_source_type(p_row_kind text)
returns public.document_source_type
language sql
immutable
as $$
  select case p_row_kind
    when 'account' then 'account_payment'::public.document_source_type
    when 'session_reg' then 'session_payment'::public.document_source_type
    when 'session_manual' then 'session_payment'::public.document_source_type
    when 'cancellation' then 'cancellation_penalty'::public.document_source_type
    else 'manual'::public.document_source_type
  end;
$$;

create or replace function public._payment_has_active_document(p_row_kind text, p_record_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.documents d
    where d.source_id = p_record_id
      and d.source_type = public._payment_document_source_type(p_row_kind)
      and d.status <> 'CANCELLED'
  );
$$;

create or replace function public.staff_list_payments_without_receipt(
  p_date_start date default null,
  p_date_end date default null,
  p_limit int default 500,
  p_offset int default 0
)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_rows json;
  v_total_count bigint;
  v_total_amount numeric(14, 2);
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  with unified as (
    select
      'account'::text as row_kind,
      'account'::text as source,
      ('account:' || a.id::text) as row_id,
      a.id as record_id,
      null::uuid as session_id,
      null::date as session_date,
      null::time as session_start_time,
      null::text as session_slot_kind,
      a.payee_id,
      a.payee_is_manual,
      round(a.amount_ils::numeric, 2) as amount_ils,
      a.payment_method,
      a.note,
      a.paid_at::timestamptz as paid_at,
      a.created_at,
      null::int as max_participants,
      false as is_kickbox,
      null::text as coach_name
    from public.athlete_account_payments a
    where a.amount_ils > 0
      and (p_date_start is null or a.paid_at >= p_date_start)
      and (p_date_end is null or a.paid_at <= p_date_end)

    union all

    select
      'session_reg',
      'session',
      ('session_reg:' || r.id::text),
      r.id,
      s.id,
      s.session_date,
      s.start_time,
      case
        when r.attended is true then 'arrival'
        when r.charge_no_show is true then 'no_show'
        else 'session'
      end,
      r.user_id,
      false,
      round(r.amount_paid::numeric, 2),
      r.payment_method,
      null::text,
      s.session_date::timestamptz,
      coalesce(r.payment_recorded_at, s.session_date::timestamptz),
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where r.status = 'active'
      and coalesce(r.amount_paid, 0) > 0
      and (r.attended is true or (r.attended is false and r.charge_no_show is true))
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)

    union all

    select
      'session_manual',
      'session',
      ('session_manual:' || m.id::text),
      m.id,
      s.id,
      s.session_date,
      s.start_time,
      case
        when m.attended is true then 'arrival'
        when m.charge_no_show is true then 'no_show'
        else 'session'
      end,
      m.manual_participant_id,
      true,
      round(m.amount_paid::numeric, 2),
      m.payment_method,
      null::text,
      s.session_date::timestamptz,
      coalesce(m.payment_recorded_at, s.session_date::timestamptz),
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where coalesce(m.amount_paid, 0) > 0
      and (m.attended is true or (m.attended is false and m.charge_no_show is true))
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)

    union all

    select
      'cancellation',
      'session',
      ('cancellation:' || c.id::text),
      c.id,
      s.id,
      s.session_date,
      s.start_time,
      'cancellation',
      c.user_id,
      false,
      round(c.penalty_collected_ils::numeric, 2),
      null::text,
      null::text,
      s.session_date::timestamptz,
      c.cancelled_at,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where c.charged_full_price is true
      and coalesce(c.penalty_collected_ils, 0) > 0
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)
  ),
  pending as (
    select u.*
    from unified u
    where not public._payment_has_active_document(u.row_kind, u.record_id)
  ),
  enriched as (
    select
      p.row_kind,
      p.source,
      p.row_id,
      p.record_id,
      p.session_id,
      p.session_date,
      p.session_start_time::text as session_start_time,
      p.session_slot_kind,
      p.payee_id,
      p.payee_is_manual,
      p.amount_ils,
      p.payment_method,
      p.note,
      p.paid_at,
      p.created_at,
      p.coach_name,
      case
        when p.row_kind = 'account' then 'other'::public.document_service_type
        else public._service_type_from_session(p.max_participants, p.is_kickbox)
      end as service_type,
      public._map_session_payment_to_document_method(p.payment_method) is null as needs_payment_method,
      coalesce(
        case when p.payee_is_manual then mp.full_name else pr.full_name end,
        'לקוח'
      ) as payee_name,
      case when p.payee_is_manual then mp.phone else pr.phone end as payee_phone
    from pending p
    left join public.profiles pr on pr.user_id = p.payee_id and not p.payee_is_manual
    left join public.manual_participants mp on mp.id = p.payee_id and p.payee_is_manual
  ),
  totals as (
    select
      count(*)::bigint as total_count,
      coalesce(round(sum(amount_ils)::numeric, 2), 0) as total_amount
    from enriched
  ),
  page as (
    select *
    from enriched
    order by paid_at desc, created_at desc, row_id desc
    limit v_limit
    offset v_offset
  )
  select
    coalesce(
      (
        select json_agg(row_to_json(p))
        from (
          select * from page
          order by paid_at desc, created_at desc, row_id desc
        ) p
      ),
      '[]'::json
    ),
    t.total_count,
    t.total_amount
  into v_rows, v_total_count, v_total_amount
  from totals t;

  return json_build_object(
    'ok', true,
    'payments', v_rows,
    'total_count', v_total_count,
    'total_amount', v_total_amount
  );
exception
  when others then
    return json_build_object('ok', false, 'error', SQLERRM);
end;
$$;

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
    where ('account:' || a.id::text) = p_row_id

    union all

    select
      'session_reg',
      ('session_reg:' || r.id::text),
      r.id,
      r.user_id,
      false,
      round(r.amount_paid::numeric, 2),
      r.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      case
        when r.attended is true then 'arrival'
        when r.charge_no_show is true then 'no_show'
        else 'session'
      end,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('session_reg:' || r.id::text) = p_row_id

    union all

    select
      'session_manual',
      ('session_manual:' || m.id::text),
      m.id,
      m.manual_participant_id,
      true,
      round(m.amount_paid::numeric, 2),
      m.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      case
        when m.attended is true then 'arrival'
        when m.charge_no_show is true then 'no_show'
        else 'session'
      end,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('session_manual:' || m.id::text) = p_row_id

    union all

    select
      'cancellation',
      ('cancellation:' || c.id::text),
      c.id,
      c.user_id,
      false,
      round(c.penalty_collected_ils::numeric, 2),
      null::text,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      'cancellation',
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('cancellation:' || c.id::text) = p_row_id
  ) q
  limit 1;

  if not found then
    return json_build_object('ok', false, 'error', 'payment_not_found', 'row_id', p_row_id);
  end if;

  if public._payment_has_active_document(v_row.row_kind, v_row.record_id) then
    return json_build_object('ok', false, 'error', 'document_already_exists', 'row_id', p_row_id);
  end if;

  v_source := public._payment_document_source_type(v_row.row_kind);
  v_source_id := v_row.record_id;

  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then
    return json_build_object('ok', false, 'error', 'digital_receipts_disabled', 'row_id', p_row_id);
  end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then
    return json_build_object('ok', false, 'error', 'business_id_required', 'row_id', p_row_id);
  end if;

  v_method := public._map_session_payment_to_document_method(v_row.payment_method);
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;

  if v_row.row_kind = 'account' then
    v_service_type := 'other';
    v_service_description := coalesce(nullif(trim(v_row.note), ''), 'תשלום בחשבון');
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

  select coalesce(p.full_name, m.full_name, 'לקוח'), coalesce(p.phone, m.phone)
  into v_customer_name, v_customer_phone
  from (select 1) x
  left join public.profiles p on p.user_id = v_profile_user_id
  left join public.manual_participants m on m.id = v_manual_participant_id;

  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(v_amount, v_settings.vat_rate);

  v_customer_id := public._upsert_customer_from_payee(
    v_customer_name, null, v_customer_phone, v_profile_user_id, v_manual_participant_id
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
    v_doc_number, v_customer_id, v_amount, v_net, v_vat, v_settings.vat_rate,
    v_method, v_service_type, v_service_description, null,
    v_status, v_customer_name, null, v_customer_phone,
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
