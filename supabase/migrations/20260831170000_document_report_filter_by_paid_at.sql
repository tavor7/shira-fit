-- Same fix as list_documents: filter/order the accountant report by the computed payment date
-- instead of created_at, which is meaningless here (every historical row shares the same
-- bulk-import created_at). Also expose paid_at on each row so the CSV export and any future
-- consumer can show the real date instead of created_at.
create or replace function public.document_report(p_date_start timestamp with time zone default null, p_date_end timestamp with time zone default null)
returns json language plpgsql stable security definer set search_path to 'public' as $function$
declare v_rows json;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(json_agg(row_to_json(t) order by t.paid_at desc), '[]'::json) into v_rows from (
    select d.document_number, d.created_at,
      coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) as paid_at,
      d.customer_name, d.gross_amount, d.net_amount, d.vat_amount, d.vat_rate,
      d.payment_method, d.service_type, d.service_description, d.status
    from public.documents d
    where (p_date_start is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) >= p_date_start)
      and (p_date_end is null or coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) <= p_date_end)
  ) t;
  return json_build_object('ok', true, 'rows', v_rows);
end; $function$;
