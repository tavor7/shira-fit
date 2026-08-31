-- Documents show when the receipt was created (documents.created_at), but staff need to see
-- when the underlying payment actually happened. Resolve that from the linked payment record.
create or replace function public._document_payment_paid_at(p_source_type public.document_source_type, p_source_id uuid)
returns timestamptz
language sql
stable
as $function$
  select case p_source_type
    when 'account_payment' then (
      select case
        -- Historical bulk-entered payments were stamped with a month-end placeholder date
        -- instead of the real payment date, and no audit trail survives to recover the truth
        -- (activity logging only started 2026-08-06). Fall back to created_at for those —
        -- closer to reality than a uniform, misleading placeholder.
        when a.paid_at = (date_trunc('month', a.paid_at) + interval '1 month - 1 day')::date
          then a.created_at
        else a.paid_at::timestamptz
      end
      from public.athlete_account_payments a where a.id = p_source_id
    )
    when 'cancellation_penalty' then (select c.cancelled_at from public.cancellations c where c.id = p_source_id)
    when 'session_payment' then coalesce(
      (select (s.session_date + s.start_time) at time zone 'Asia/Jerusalem'
       from public.session_registrations r join public.training_sessions s on s.id = r.session_id
       where r.id = p_source_id),
      (select (s.session_date + s.start_time) at time zone 'Asia/Jerusalem'
       from public.session_manual_participants m join public.training_sessions s on s.id = m.session_id
       where m.id = p_source_id)
    )
    else null
  end;
$function$;

create or replace function public.list_documents(
  p_date_start timestamp with time zone default null,
  p_date_end timestamp with time zone default null,
  p_status document_status default null,
  p_customer_type text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_rows json;
  v_total bigint;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_customer_type is not null and p_customer_type not in ('regular', 'manual', 'family') then
    return json_build_object('ok', false, 'error', 'invalid_customer_type');
  end if;

  select count(*) into v_total
  from public.documents d
  join public.customers c on c.id = d.customer_id
  where (p_date_start is null or d.created_at >= p_date_start)
    and (p_date_end is null or d.created_at <= p_date_end)
    and (p_status is null or d.status = p_status)
    and (
      p_customer_type is null
      or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
    );

  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json) into v_rows
  from (
    select
      d.*,
      c.profile_user_id as customer_profile_user_id,
      c.manual_participant_id as customer_manual_participant_id,
      public._document_customer_type(c.profile_user_id, c.manual_participant_id) as customer_type,
      coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) as paid_at
    from public.documents d
    join public.customers c on c.id = d.customer_id
    where (p_date_start is null or d.created_at >= p_date_start)
      and (p_date_end is null or d.created_at <= p_date_end)
      and (p_status is null or d.status = p_status)
      and (
        p_customer_type is null
        or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
      )
    order by d.created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return json_build_object('ok', true, 'rows', v_rows, 'total', v_total);
end;
$function$;
