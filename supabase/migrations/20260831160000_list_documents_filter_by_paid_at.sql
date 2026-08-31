-- All 162 historical documents share the same created_at (the day they were bulk-imported into
-- the digital-receipts system), so filtering/ordering by created_at makes date-range filters
-- (e.g. "June 2026") return nothing even though the receipts genuinely belong to that period.
-- Filter and order by the same computed payment date already returned as `paid_at`.
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
  where (p_date_start is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) >= p_date_start)
    and (p_date_end is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) <= p_date_end)
    and (p_status is null or d.status = p_status)
    and (
      p_customer_type is null
      or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
    );

  select coalesce(json_agg(row_to_json(t) order by t.paid_at desc), '[]'::json) into v_rows
  from (
    select
      d.*,
      c.profile_user_id as customer_profile_user_id,
      c.manual_participant_id as customer_manual_participant_id,
      public._document_customer_type(c.profile_user_id, c.manual_participant_id) as customer_type,
      coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) as paid_at
    from public.documents d
    join public.customers c on c.id = d.customer_id
    where (p_date_start is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) >= p_date_start)
      and (p_date_end is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) <= p_date_end)
      and (p_status is null or d.status = p_status)
      and (
        p_customer_type is null
        or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
      )
    order by paid_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return json_build_object('ok', true, 'rows', v_rows, 'total', v_total);
end;
$function$;
