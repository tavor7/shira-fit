-- Cancellation penalties never captured a payment method, so every late-cancellation
-- charge was permanently flagged "needs_payment_method" in the pending-receipts UI
-- (the three read paths below all hardcoded payment_method as null for cancellation rows).
-- Add the column, let managers record it when collecting the penalty, and wire it through.

alter table public.cancellations
  add column if not exists payment_method text;

comment on column public.cancellations.payment_method is
  'How the late-cancellation penalty was collected (cash/paybox/mom/other), set via manager_set_cancellation_penalty_collected.';

drop function if exists public.manager_set_cancellation_penalty_collected(uuid, numeric);

create or replace function public.manager_set_cancellation_penalty_collected(
  p_cancellation_id uuid,
  p_collected_ils numeric,
  p_payment_method text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  s_row training_sessions%rowtype;
  v_price numeric(12, 2);
  v_amt numeric(12, 2);
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_collected_ils is null or p_collected_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if c_row.charged_full_price is not true then
    return json_build_object('ok', false, 'error', 'not_chargeable');
  end if;

  select * into s_row from public.training_sessions where id = c_row.session_id;
  select scp.price_ils into v_price
  from public.session_capacity_pricing scp
  where scp.max_participants = s_row.max_participants;
  if v_price is null then v_price := 0; end if;

  v_amt := least(round(p_collected_ils::numeric, 2), v_price)::numeric(12, 2);

  update public.cancellations
  set penalty_collected_ils = v_amt,
      payment_method = v_pay
  where id = p_cancellation_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.manager_set_cancellation_penalty_collected(uuid, numeric, text) to authenticated;

create or replace function public.staff_list_payments_without_receipt(p_date_start date default null::date, p_date_end date default null::date, p_limit integer default 500, p_offset integer default 0)
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_floor date := '2026-06-14'::date;
  v_start date := greatest(coalesce(p_date_start, v_floor), v_floor);
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
      and public.normalize_payment_method_key(a.payment_method) <> 'discount'
      and a.paid_at >= v_start
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
      and s.session_date >= v_start
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
      and s.session_date >= v_start
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
      c.payment_method,
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
      and s.session_date >= v_start
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
$function$;

create or replace function public._create_document_from_payment_row(p_row_id text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_settings public.receipt_settings%rowtype;
  v_effective_vat_rate numeric(5,4);
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
  v_customer_email text;
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
      c.payment_method,
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

  select coalesce(p.full_name, m.full_name, 'לקוח'), coalesce(p.phone, m.phone),
         coalesce(p.address, ''), coalesce(p.zip_code, '')
  into v_customer_name, v_customer_phone, v_customer_address, v_customer_zip
  from (select 1) x
  left join public.profiles p on p.user_id = v_profile_user_id
  left join public.manual_participants m on m.id = v_manual_participant_id;

  v_customer_email := public._resolve_customer_email(v_profile_user_id, null);

  v_effective_vat_rate := case when v_settings.vat_enabled then v_settings.vat_rate else 0 end;
  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(v_amount, v_effective_vat_rate);

  v_customer_id := public._upsert_customer_from_payee(
    v_customer_name, v_customer_email, v_customer_phone,
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
    v_doc_number, v_customer_id, v_amount, v_net, v_vat, v_effective_vat_rate,
    v_method, v_service_type, v_service_description, null,
    v_status, v_customer_name, v_customer_email, v_customer_phone,
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
$function$;

create or replace function public.staff_list_received_payments(p_date_start date default null::date, p_date_end date default null::date, p_payee_id uuid default null::uuid, p_payee_is_manual boolean default null::boolean, p_payee_filters jsonb default null::jsonb, p_payment_method text default null::text, p_limit integer default 500, p_offset integer default 0)
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_method text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_rows json;
  v_total_received numeric(14, 2);
  v_total_count bigint;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  with unified as (
    select
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
      a.payer_name,
      a.paid_at,
      a.created_at,
      a.created_by,
      exists (
        select 1 from public.external_manual_receipts e
        where e.row_kind = 'account' and e.record_id = a.id
      ) as has_manual_receipt
    from public.athlete_account_payments a
    where a.amount_ils > 0
      and (p_date_start is null or a.paid_at >= p_date_start)
      and (p_date_end is null or a.paid_at <= p_date_end)
      and public._received_payment_payee_match(
        a.payee_id,
        a.payee_is_manual,
        p_payee_id,
        p_payee_is_manual,
        p_payee_filters
      )
      and (
        v_method is null
        or public.normalize_payment_method_key(a.payment_method) = v_method
      )

    union all

    select
      'session'::text,
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
      null::text,
      s.session_date,
      coalesce(r.payment_recorded_at, s.session_date::timestamptz),
      r.payment_recorded_by,
      exists (
        select 1 from public.external_manual_receipts e
        where e.row_kind = 'session_reg' and e.record_id = r.id
      )
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    where r.status = 'active'
      and coalesce(r.amount_paid, 0) > 0
      and (
        r.attended is true
        or (r.attended is false and r.charge_no_show is true)
      )
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)
      and public._received_payment_payee_match(
        r.user_id,
        false,
        p_payee_id,
        p_payee_is_manual,
        p_payee_filters
      )
      and (
        v_method is null
        or public.normalize_payment_method_key(r.payment_method) = v_method
      )

    union all

    select
      'session'::text,
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
      null::text,
      s.session_date,
      coalesce(m.payment_recorded_at, s.session_date::timestamptz),
      m.payment_recorded_by,
      exists (
        select 1 from public.external_manual_receipts e
        where e.row_kind = 'session_manual' and e.record_id = m.id
      )
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    where coalesce(m.amount_paid, 0) > 0
      and (
        m.attended is true
        or (m.attended is false and m.charge_no_show is true)
      )
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)
      and public._received_payment_payee_match(
        m.manual_participant_id,
        true,
        p_payee_id,
        p_payee_is_manual,
        p_payee_filters
      )
      and (
        v_method is null
        or public.normalize_payment_method_key(m.payment_method) = v_method
      )

    union all

    select
      'session'::text,
      ('cancellation:' || c.id::text),
      c.id,
      s.id,
      s.session_date,
      s.start_time,
      'cancellation'::text,
      c.user_id,
      false,
      round(c.penalty_collected_ils::numeric, 2),
      c.payment_method,
      null::text,
      null::text,
      s.session_date,
      c.cancelled_at,
      null::uuid,
      exists (
        select 1 from public.external_manual_receipts e
        where e.row_kind = 'cancellation' and e.record_id = c.id
      )
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    where c.charged_full_price is true
      and coalesce(c.penalty_collected_ils, 0) > 0
      and (p_date_start is null or s.session_date >= p_date_start)
      and (p_date_end is null or s.session_date <= p_date_end)
      and public._received_payment_payee_match(
        c.user_id,
        false,
        p_payee_id,
        p_payee_is_manual,
        p_payee_filters
      )
      and (
        v_method is null
        or public.normalize_payment_method_key(c.payment_method) = v_method
      )
  ),
  totals as (
    select
      coalesce(round(sum(u.amount_ils) filter (
        where public.normalize_payment_method_key(u.payment_method) <> 'discount'
      )::numeric, 2), 0) as total_received,
      count(*)::bigint as total_count
    from unified u
  ),
  page as (
    select
      u.source,
      u.row_id,
      u.record_id,
      u.session_id,
      u.session_date,
      u.session_start_time::text as session_start_time,
      u.session_slot_kind,
      u.payee_id,
      u.payee_is_manual,
      u.amount_ils,
      u.payment_method,
      u.note,
      u.payer_name,
      u.paid_at,
      u.created_at,
      u.created_by,
      u.has_manual_receipt
    from unified u
    order by u.paid_at desc, u.created_at desc, u.row_id desc
    limit v_limit
    offset v_offset
  )
  select
    coalesce((select json_agg(p order by p.paid_at desc, p.created_at desc, p.row_id desc) from page p), '[]'::json),
    t.total_received,
    t.total_count
  into v_rows, v_total_received, v_total_count
  from totals t;

  return json_build_object(
    'ok', true,
    'total_received', v_total_received,
    'total_count', v_total_count,
    'payments', v_rows
  );
end;
$function$;
