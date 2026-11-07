-- Bulk receipts: allocate numbers in business payment order, not in the order the client sent the rows.
--
-- create_documents_from_payments numbered rows in the order of p_row_ids. "Select all" sends the pending list's order
-- (newest payment date first, ties by most recent recording time), so both bulk batches issued on 2026-10-06
-- (001075-001255, 001256-001428) are numbered newest-first: 354 of 354 receipts match that order in production.
--
-- Now the batch is sorted on the server before any number is allocated:
--   1. business payment time, earliest first, as Israel wall-clock time (_payment_business_local_ts):
--        session payment       session_date + start_time (the scheduled start)
--        account payment       paid_at, the date the manager entered, at 00:00 UTC (02:00/03:00 in Israel, so always
--                              on that Israel calendar date). This is the instant the Receipts list and reports already
--                              use (_document_payment_paid_at under the production TimeZone, UTC), so the numbering order
--                              and the Receipts list order agree for every kind, including night-time cancellations.
--                              Spelled out with an explicit UTC conversion so it does not depend on the session TimeZone.
--        cancellation penalty  cancelled_at in Asia/Jerusalem
--   2. kind: account, then session (registered or quick-add), then cancellation
--   3. row_id, so equal times always come out in the same order
-- Selection order and recording times (payment_recorded_at, created_at) play no part. Rows that cannot be resolved sort
-- last and fail as before, without consuming a number (the per-row exception block rolls the allocation back).
--
-- bulk_receipt_issue_preview lets the client warn, without blocking, when selected payments are dated before an
-- already-issued receipt: those receive numbers after it, because issued numbers never change.
--
-- No existing document, number, PDF or payment is modified.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments') <> 1 then
    raise exception 'precondition: create_documents_from_payments must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments')
     <> '91160202cc1c8f0a78a595f491323a4c' then
    raise exception 'precondition: source of create_documents_from_payments differs from the reviewed version; refusing to change it';
  end if;
end $$;

-- Business payment time of a document's source, as Israel wall-clock time: the same instant as _document_payment_paid_at
-- (production TimeZone UTC), independent of the session TimeZone.
create or replace function public._business_local_ts(p_source_type public.document_source_type, p_source_id uuid)
returns timestamp
language sql
stable
set search_path to 'public'
as $function$
  select case p_source_type
    when 'account_payment' then (
      select (a.paid_at::timestamp at time zone 'UTC') at time zone 'Asia/Jerusalem'
      from public.athlete_account_payments a where a.id = p_source_id
    )
    when 'cancellation_penalty' then (select c.cancelled_at at time zone 'Asia/Jerusalem' from public.cancellations c where c.id = p_source_id)
    when 'session_payment' then coalesce(
      (select s.session_date + s.start_time
       from public.session_registrations r join public.training_sessions s on s.id = r.session_id where r.id = p_source_id),
      (select s.session_date + s.start_time
       from public.session_manual_participants m join public.training_sessions s on s.id = m.session_id where m.id = p_source_id)
    )
    else null
  end;
$function$;

-- The same, for a pending-payment row id ('account:<uuid>', 'session_reg:<uuid>', 'session_manual:<uuid>',
-- 'cancellation:<uuid>'). Null when the id is malformed or the payment does not exist.
create or replace function public._payment_row_business_local_ts(p_row_id text)
returns timestamp
language sql
stable
set search_path to 'public'
as $function$
  select case
    when p_row_id ~ '^(account|session_reg|session_manual|cancellation):[0-9a-fA-F-]{36}$' then
      public._business_local_ts(public._payment_document_source_type(split_part(p_row_id, ':', 1)), split_part(p_row_id, ':', 2)::uuid)
  end;
$function$;

create or replace function public._payment_row_kind_rank(p_row_id text)
returns int
language sql
immutable
as $function$
  select case split_part(p_row_id, ':', 1)
    when 'account' then 1
    when 'session_reg' then 2
    when 'session_manual' then 2
    when 'cancellation' then 3
    else 4
  end;
$function$;

revoke all on function public._business_local_ts(public.document_source_type, uuid) from public, anon, authenticated;
revoke all on function public._payment_row_business_local_ts(text) from public, anon, authenticated;
revoke all on function public._payment_row_kind_rank(text) from public, anon, authenticated;

create or replace function public.create_documents_from_payments(p_row_ids jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
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
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_row_ids is null or jsonb_typeof(p_row_ids) <> 'array' or jsonb_array_length(p_row_ids) = 0 then
    return json_build_object('ok', false, 'error', 'no_rows_selected');
  end if;
  if jsonb_array_length(p_row_ids) > 500 then
    return json_build_object('ok', false, 'error', 'too_many_rows');
  end if;

  -- Numbers are allocated in this order: business time, kind, row id. Never the order of p_row_ids.
  for v_row_id in
    select x.row_id
    from (
      select trim(both '"' from value::text) as row_id
      from jsonb_array_elements(p_row_ids)
    ) x
    order by public._payment_row_business_local_ts(x.row_id) asc nulls last,
             public._payment_row_kind_rank(x.row_id),
             x.row_id
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

-- Read-only. How many of the selected payments are dated before the latest already-issued (not cancelled) receipt,
-- and which receipt that is. Those payments still get receipts, numbered after it.
create or replace function public.bulk_receipt_issue_preview(p_row_ids jsonb)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_latest_ts timestamp;
  v_latest_number text;
  v_count int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_row_ids is null or jsonb_typeof(p_row_ids) <> 'array' then
    return json_build_object('ok', false, 'error', 'no_rows_selected');
  end if;

  select x.ts, x.document_number into v_latest_ts, v_latest_number
  from (
    select public._business_local_ts(d.source_type, d.source_id) as ts, d.document_number
    from public.documents d
    where d.status <> 'CANCELLED' and d.source_id is not null
  ) x
  where x.ts is not null
  order by x.ts desc, x.document_number desc
  limit 1;

  select count(*) into v_count
  from jsonb_array_elements(p_row_ids) e
  where v_latest_ts is not null
    and public._payment_row_business_local_ts(trim(both '"' from e.value::text)) < v_latest_ts;

  return json_build_object(
    'ok', true,
    'predating_count', v_count,
    'latest_issued_number', v_latest_number,
    'latest_issued_business_at', v_latest_ts
  );
end;
$function$;

revoke all on function public.bulk_receipt_issue_preview(jsonb) from public, anon;
grant execute on function public.bulk_receipt_issue_preview(jsonb) to authenticated, service_role;

do $$
begin
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments')
     not like '%jsonb_array_length(p_row_ids) > 500%' then
    raise exception 'self-check: the 500-row batch cap was not preserved';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments')
     not like '%is_manager(v_uid)%' then
    raise exception 'self-check: create_documents_from_payments is not manager-only';
  end if;
  if has_function_privilege('authenticated', 'public._create_document_from_payment_row(text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _create_document_from_payment_row must stay client-unreachable';
  end if;
end $$;
