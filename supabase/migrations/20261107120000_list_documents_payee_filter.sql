-- Receipts screen: a payee filter over a wide range (e.g. Global) showed "No documents for this name" for payees whose
-- receipts were real and visible under a single month. list_documents returned only the newest page (200 rows) of the
-- whole range and the client filtered that page by payee, so any payee whose receipts fell outside the newest 200 was
-- hidden. In production on 2026-11-07, 516 documents fell in the Global range and the 200th was dated 2026-07-29.
--
-- Fix: filter by payee in the query, before limit/offset, and break ties in the payment-date order by document_number so
-- offset pages neither repeat nor skip rows (many session receipts share one session start time).
--
-- Read-only RPC change. No document, number, date or payment is touched. Date semantics (the computed payment date,
-- _document_payment_paid_at, falling back to created_at), the manager-only guard and the 500-row cap are unchanged.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'list_documents') <> 1 then
    raise exception 'precondition: list_documents must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'list_documents')
     <> '7bcf5727e5921f3508c46b740439b9f8' then
    raise exception 'precondition: source of list_documents differs from the reviewed version; refusing to change it';
  end if;
end $$;

-- A new trailing parameter would otherwise leave two overloads, and 6-argument calls would become ambiguous.
drop function public.list_documents(timestamptz, timestamptz, public.document_status, text, integer, integer);

create function public.list_documents(
  p_date_start timestamp with time zone default null,
  p_date_end timestamp with time zone default null,
  p_status document_status default null,
  p_customer_type text default null,
  p_limit integer default 200,
  p_offset integer default 0,
  p_profile_user_id uuid default null,
  p_manual_participant_id uuid default null
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
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_customer_type is not null and p_customer_type not in ('regular', 'manual', 'family') then
    return json_build_object('ok', false, 'error', 'invalid_customer_type');
  end if;
  if p_profile_user_id is not null and p_manual_participant_id is not null then
    return json_build_object('ok', false, 'error', 'invalid_payee_filter');
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
    )
    and (p_profile_user_id is null or c.profile_user_id = p_profile_user_id)
    and (p_manual_participant_id is null or c.manual_participant_id = p_manual_participant_id);

  select coalesce(json_agg(x.row_json order by x.paid_at_sort desc, x.document_number desc), '[]'::json) into v_rows
  from (
    select
      jsonb_set(
        to_jsonb(d) || jsonb_build_object(
          'customer_profile_user_id', c.profile_user_id,
          'customer_manual_participant_id', c.manual_participant_id,
          'customer_type', public._document_customer_type(c.profile_user_id, c.manual_participant_id)
        ),
        '{paid_at}',
        to_jsonb(coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at))
      ) as row_json,
      coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) as paid_at_sort,
      d.document_number
    from public.documents d
    join public.customers c on c.id = d.customer_id
    where (p_date_start is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) >= p_date_start)
      and (p_date_end is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) <= p_date_end)
      and (p_status is null or d.status = p_status)
      and (
        p_customer_type is null
        or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
      )
      and (p_profile_user_id is null or c.profile_user_id = p_profile_user_id)
      and (p_manual_participant_id is null or c.manual_participant_id = p_manual_participant_id)
    order by coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) desc, d.document_number desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) x;

  return json_build_object('ok', true, 'rows', v_rows, 'total', v_total);
end;
$function$;

revoke all on function public.list_documents(timestamptz, timestamptz, public.document_status, text, integer, integer, uuid, uuid) from public, anon;
grant execute on function public.list_documents(timestamptz, timestamptz, public.document_status, text, integer, integer, uuid, uuid) to authenticated, service_role;
