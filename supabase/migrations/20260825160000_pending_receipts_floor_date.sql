-- Payments dated before 2026-06-14 are historical/testing data and should never surface as
-- "pending a receipt", regardless of what date range the UI requests — they still show
-- normally in Payments received (staff_list_received_payments is untouched by this).

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
$$;
