-- Records in the repository the create_documents_from_payments definition that production already runs:
-- the bulk receipt-creation cap is 500 row ids per call (100 in 20260629120000). The 500 cap was applied to
-- production directly and never committed, so a replay from this repository would silently restore 100.
-- The body below is copied verbatim from production (pg_get_functiondef). CREATE OR REPLACE keeps the existing
-- owner and EXECUTE grants, so applying this to production changes nothing.

create or replace function public.create_documents_from_payments(p_row_ids jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $function$
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
$function$;

comment on function public.create_documents_from_payments(jsonb) is
  'Bulk-create receipt documents for existing payments by staff_list_received_payments row_id values. Accepts up to 500 row ids per call.';

-- Self-check: the stored definition is byte-identical to production's.
do $$
begin
  if md5(pg_get_functiondef('public.create_documents_from_payments(jsonb)'::regprocedure)) <> 'da1521698be186f75620d6ffeecb5826' then
    raise exception 'create_documents_from_payments does not match the production definition';
  end if;
end;
$$;
