-- staff_list_received_payments (the "Payments received" ledger screen) summed ALL
-- account payments — including 'discount' — into total_received. Individual discount rows
-- still need to show up here (so staff can find/edit/remove them, same as any other
-- payment), but the headline total_received figure shouldn't count them as real money,
-- consistent with computeBillingSummary (client) and manager_weekly_stats_core (server) —
-- both already fixed to exclude discount from "received".
--
-- Only the `totals` CTE's sum changed (now filtered); the `unified`/`page` row-level
-- output is untouched, so discount rows still appear in the list itself. Full function
-- body otherwise byte-for-byte identical to the live definition.

create or replace function public.staff_list_received_payments(
  p_date_start date default null,
  p_date_end date default null,
  p_payee_id uuid default null,
  p_payee_is_manual boolean default null,
  p_payee_filters jsonb default null,
  p_payment_method text default null,
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
      null::text,
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
      and v_method is null
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
$$;
