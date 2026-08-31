-- Raise the bulk receipt-creation row cap from 100 to 500 (matching the pending
-- receipts list page size). Managers regularly select more than 100 pending
-- payments at once (e.g. via "select all" on a wide date range), and the old
-- cap rejected the whole request with a bare "too_many_rows" error instead of
-- creating anything.
create or replace function public.create_documents_from_payments(p_row_ids jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row_id text;
  v_result json;
  v_created jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_count int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_row_ids is null or jsonb_typeof(p_row_ids) <> 'array' or jsonb_array_length(p_row_ids) = 0 then
    return json_build_object('ok', false, 'error', 'no_rows_selected');
  end if;
  if jsonb_array_length(p_row_ids) > 500 then
    return json_build_object('ok', false, 'error', 'too_many_rows');
  end if;

  for v_row_id in
    select trim(both '"' from value::text)
    from jsonb_array_elements(p_row_ids)
  loop
    v_result := public._create_document_from_payment_row(v_row_id);
    if coalesce((v_result->>'ok')::boolean, false) then
      v_created := v_created || jsonb_build_array(v_result);
      v_count := v_count + 1;
    else
      v_failed := v_failed || jsonb_build_array(v_result);
    end if;
  end loop;

  return json_build_object(
    'ok', true,
    'created_count', v_count,
    'failed_count', jsonb_array_length(v_failed),
    'created', v_created,
    'failed', v_failed
  );
end;
$$;

grant execute on function public.create_documents_from_payments(jsonb) to authenticated;

comment on function public.create_documents_from_payments(jsonb) is
  'Bulk-create receipt documents for existing payments by staff_list_received_payments row_id values. Accepts up to 500 row ids per call.';
