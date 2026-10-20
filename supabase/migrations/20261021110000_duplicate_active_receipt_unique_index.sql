-- Financial integrity: enforce "at most one active receipt per payment source" at the database level.
--
-- Confirmed defect (read-only investigation, production): _create_document_from_payment_row (used by
-- create_documents_from_payments, the deferred-receipt path) and create_document_with_payment (the
-- integrated session/account path) both check `_payment_has_active_document` before inserting, but
-- create_document -- the plain, freeform receipt RPC -- has no such check at all. All three insert into the
-- SAME documents table, so two different RPCs (or two concurrent calls to the same one) can race past their own
-- independent, in-process pre-checks and both insert an active receipt for the same payment. An application-level
-- check can never close this by itself (TOCTOU: check-then-insert is not atomic across two separate backends).
--
-- Verified before adding the constraint (read-only, production): zero existing (source_type, source_id) pairs
-- have more than one non-cancelled document today -- confirmed by
--   select source_type, source_id, count(*) from documents where status <> 'CANCELLED' and source_id is not null
--   group by 1,2 having count(*) > 1;
-- returning no rows. The migration's own DO block below re-asserts this against whatever database it runs
-- against and refuses to proceed if it is not true, rather than silently creating an index that would fail, or
-- silently altering/deleting any existing duplicate.
--
-- Scope of the invariant: only the three source types that identify an actual payment --
-- 'account_payment', 'session_payment', 'cancellation_penalty'. 'manual' documents (freeform, no payment source,
-- e.g. source_id is null in every production row) are explicitly excluded, so creating any number of unrelated
-- manual/invoice-style documents is never affected. A CANCELLED document never counts as active, so a legitimate
-- replacement receipt after cancellation is never blocked by this index -- re-verified by a dedicated test.

do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes from (
    select source_type, source_id
    from public.documents
    where status <> 'CANCELLED' and source_id is not null
      and source_type in ('account_payment', 'session_payment', 'cancellation_penalty')
    group by source_type, source_id
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception 'precondition: % existing payment source(s) already have more than one active receipt; refusing to add the unique index until this is reconciled manually', v_dupes;
  end if;
end $$;

create unique index if not exists documents_active_payment_source_uidx
  on public.documents (source_type, source_id)
  where status <> 'CANCELLED'
    and source_id is not null
    and source_type in ('account_payment', 'session_payment', 'cancellation_penalty');

comment on index public.documents_active_payment_source_uidx is
  'At most one non-cancelled receipt per (source_type, source_id) for the three source types that identify an actual payment. Excludes source_type = manual (no payment source) and any CANCELLED document, so a replacement receipt after cancellation is never blocked. This is the authoritative, concurrency-safe guarantee; create_document / create_document_with_payment / _create_document_from_payment_row also pre-check for a friendly error, but this index is what actually prevents a race.';

-- create_document: add the same pre-check the integrated paths already have, PLUS catch the unique_violation
-- the new index can now raise under a genuine race (two concurrent calls both passing the pre-check), so a
-- losing concurrent caller gets the same friendly {ok:false, error:'document_already_exists'} instead of a raw
-- database exception. Also rejects issuing a receipt for an already-reversed account payment (2026-10-21,
-- companion migration 20261021100000).
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_document') <> 1 then
    raise exception 'precondition: create_document must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_document')
     <> 'af3acf580441e1e429fee74e20951631' then
    raise exception 'precondition: source of create_document differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.create_document(
  p_gross_amount numeric,
  p_service_type public.document_service_type,
  p_customer_name text,
  p_customer_email text default null::text,
  p_customer_phone text default null::text,
  p_payment_method public.document_payment_method default null::public.document_payment_method,
  p_service_description text default null::text,
  p_notes text default null::text,
  p_profile_user_id uuid default null::uuid,
  p_manual_participant_id uuid default null::uuid,
  p_source_type public.document_source_type default 'manual'::public.document_source_type,
  p_source_id uuid default null::uuid,
  p_source_payment_method text default null::text
)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_settings public.receipt_settings%rowtype;
  v_effective_vat_rate numeric(5,4);
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12,2);
  v_vat numeric(12,2);
  v_method public.document_payment_method;
  v_status public.document_status;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_customer_email text;
  v_paid_at date;
  v_existing_doc uuid;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then return json_build_object('ok', false, 'error', 'digital_receipts_disabled'); end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then return json_build_object('ok', false, 'error', 'business_id_required'); end if;
  if p_gross_amount is null or p_gross_amount <= 0 then return json_build_object('ok', false, 'error', 'invalid_amount'); end if;

  if p_source_type in ('account_payment', 'session_payment', 'cancellation_penalty') and p_source_id is not null then
    select id into v_existing_doc
    from public.documents
    where source_type = p_source_type and source_id = p_source_id and status <> 'CANCELLED'
    limit 1;
    if v_existing_doc is not null then
      return json_build_object('ok', false, 'error', 'document_already_exists', 'document_id', v_existing_doc);
    end if;
  end if;

  if p_source_type = 'account_payment' and p_source_id is not null then
    if exists (select 1 from public.athlete_account_payments where id = p_source_id and reversed_at is not null) then
      return json_build_object('ok', false, 'error', 'payment_reversed');
    end if;
  end if;

  v_method := p_payment_method;
  if v_method is null and p_source_payment_method is not null then
    v_method := public._map_session_payment_to_document_method(p_source_payment_method);
  end if;
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;
  v_effective_vat_rate := case when v_settings.vat_enabled then v_settings.vat_rate else 0 end;
  select net_amount, vat_amount into v_net, v_vat from public._document_vat_breakdown(p_gross_amount, v_effective_vat_rate);

  if p_source_type = 'account_payment' and p_source_id is not null then
    select paid_at into v_paid_at from public.athlete_account_payments where id = p_source_id;
  end if;
  v_paid_at := coalesce(v_paid_at, (timezone('Asia/Jerusalem', now()))::date);

  if p_profile_user_id is not null then
    select coalesce(p.address, ''), coalesce(p.zip_code, '')
    into v_customer_address, v_customer_zip
    from public.profiles p where p.user_id = p_profile_user_id;
  end if;

  v_customer_email := public._resolve_customer_email(p_profile_user_id, p_customer_email);

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, v_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );
  v_doc_number := public._allocate_document_number();
  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by, paid_at
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_effective_vat_rate,
    v_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    v_customer_email, nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    p_source_type, p_source_id, auth.uid(), v_paid_at
  ) returning id into v_doc_id;
  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object('document_number', v_doc_number, 'gross_amount', p_gross_amount));
  return json_build_object('ok', true, 'document_id', v_doc_id, 'document_number', v_doc_number, 'status', v_status, 'needs_pdf', true);
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'document_already_exists');
end;
$function$;

comment on function public.create_document(numeric, public.document_service_type, text, text, text, public.document_payment_method, text, text, uuid, uuid, public.document_source_type, uuid, text) is
  'Manager-only freeform receipt/invoice creation. As of 2026-10-21: rejects a duplicate active receipt for the same payment source (pre-check + unique_violation catch against documents_active_payment_source_uidx) and rejects issuing a receipt for an already-reversed account payment.';

-- create_document_with_payment: add the same unique_violation safety net around its final insert (it already
-- has an application-level pre-check for session mode; account mode always creates a brand-new payment row, so
-- it can never target an existing/reversed one).
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_document_with_payment') <> 1 then
    raise exception 'precondition: create_document_with_payment must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_document_with_payment')
     <> 'aed82e5ae68d538cfcd56889bc66433d' then
    raise exception 'precondition: source of create_document_with_payment differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.create_document_with_payment(
  p_mode text,
  p_gross_amount numeric,
  p_service_type public.document_service_type,
  p_payment_method public.document_payment_method,
  p_customer_name text,
  p_customer_email text default null::text,
  p_customer_phone text default null::text,
  p_service_description text default null::text,
  p_notes text default null::text,
  p_profile_user_id uuid default null::uuid,
  p_manual_participant_id uuid default null::uuid,
  p_session_id uuid default null::uuid,
  p_paid_at date default null::date,
  p_record_payment boolean default true
)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_settings public.receipt_settings%rowtype;
  v_effective_vat_rate numeric(5, 4);
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12, 2);
  v_vat numeric(12, 2);
  v_status public.document_status;
  v_source_type public.document_source_type;
  v_source_id uuid;
  v_session_method text;
  v_reg_id uuid;
  v_manual_row_id uuid;
  v_payment_id uuid;
  v_att json;
  v_existing_doc uuid;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_customer_email text;
  v_paid_at date;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_mode not in ('session', 'account') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;
  if p_gross_amount is null or p_gross_amount <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_payment_method is null then
    return json_build_object('ok', false, 'error', 'payment_method_required');
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then
    return json_build_object('ok', false, 'error', 'digital_receipts_disabled');
  end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then
    return json_build_object('ok', false, 'error', 'business_id_required');
  end if;

  if p_profile_user_id is not null then
    select coalesce(p.address, ''), coalesce(p.zip_code, '')
    into v_customer_address, v_customer_zip
    from public.profiles p where p.user_id = p_profile_user_id;
  end if;

  v_session_method := public._document_payment_to_session_method(p_payment_method);
  v_status := 'ACTIVE';
  v_paid_at := coalesce(p_paid_at, (timezone('Asia/Jerusalem', now()))::date);

  if p_mode = 'session' then
    if p_session_id is null then
      return json_build_object('ok', false, 'error', 'session_id_required');
    end if;

    if p_profile_user_id is not null then
      select r.id into v_reg_id
      from public.session_registrations r
      where r.session_id = p_session_id and r.user_id = p_profile_user_id and r.status = 'active';
      if not found then
        return json_build_object('ok', false, 'error', 'not_on_roster');
      end if;

      select d.id into v_existing_doc
      from public.documents d
      where d.source_type = 'session_payment' and d.source_id = v_reg_id and d.status <> 'CANCELLED'
      limit 1;
      if v_existing_doc is not null then
        return json_build_object('ok', false, 'error', 'document_already_exists', 'document_id', v_existing_doc);
      end if;

      if p_record_payment then
        v_att := public.set_registration_attendance(
          p_session_id, p_profile_user_id, 'arrived', v_session_method, p_gross_amount, false
        );
        if coalesce((v_att->>'ok')::boolean, false) is not true then
          return v_att;
        end if;
      end if;

      v_source_type := 'session_payment';
      v_source_id := v_reg_id;

    elsif p_manual_participant_id is not null then
      select m.id into v_manual_row_id
      from public.session_manual_participants m
      where m.session_id = p_session_id and m.manual_participant_id = p_manual_participant_id;
      if not found then
        return json_build_object('ok', false, 'error', 'not_on_roster');
      end if;

      select d.id into v_existing_doc
      from public.documents d
      where d.source_type = 'session_payment' and d.source_id = v_manual_row_id and d.status <> 'CANCELLED'
      limit 1;
      if v_existing_doc is not null then
        return json_build_object('ok', false, 'error', 'document_already_exists', 'document_id', v_existing_doc);
      end if;

      if p_record_payment then
        v_att := public.set_manual_participant_attendance(
          p_session_id, p_manual_participant_id, 'arrived', v_session_method, p_gross_amount, false
        );
        if coalesce((v_att->>'ok')::boolean, false) is not true then
          return v_att;
        end if;
      end if;

      v_source_type := 'session_payment';
      v_source_id := v_manual_row_id;
    else
      return json_build_object('ok', false, 'error', 'payee_required');
    end if;
  else
    insert into public.athlete_account_payments (
      payee_id,
      payee_is_manual,
      amount_ils,
      payment_method,
      note,
      paid_at
    )
    values (
      coalesce(p_profile_user_id, p_manual_participant_id),
      p_manual_participant_id is not null,
      p_gross_amount,
      v_session_method,
      nullif(trim(coalesce(p_notes, '')), ''),
      v_paid_at
    )
    returning id into v_payment_id;

    v_source_type := 'account_payment';
    v_source_id := v_payment_id;
  end if;

  v_effective_vat_rate := case when v_settings.vat_enabled then v_settings.vat_rate else 0 end;
  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(p_gross_amount, v_effective_vat_rate);

  v_customer_email := public._resolve_customer_email(p_profile_user_id, p_customer_email);

  v_customer_id := public._upsert_customer_from_payee(
    p_customer_name, v_customer_email, p_customer_phone,
    p_profile_user_id, p_manual_participant_id,
    v_customer_address, v_customer_zip
  );

  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by, paid_at
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_effective_vat_rate,
    p_payment_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    v_customer_email, nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    v_source_type, v_source_id, auth.uid(), v_paid_at
  ) returning id into v_doc_id;

  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object(
    'document_number', v_doc_number,
    'gross_amount', p_gross_amount,
    'mode', p_mode,
    'source_type', v_source_type,
    'source_id', v_source_id
  ));

  return json_build_object(
    'ok', true,
    'document_id', v_doc_id,
    'document_number', v_doc_number,
    'status', v_status,
    'needs_pdf', true,
    'source_type', v_source_type,
    'source_id', v_source_id,
    'payment_recorded', p_record_payment or p_mode = 'account'
  );
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'document_already_exists');
end;
$function$;

comment on function public.create_document_with_payment(text, numeric, public.document_service_type, public.document_payment_method, text, text, text, text, text, uuid, uuid, uuid, date, boolean) is
  'Manager-only integrated receipt+payment RPC. As of 2026-10-21: a unique_violation on the final insert (a genuine concurrent race past the existing pre-check) is caught and returned as the same friendly document_already_exists code, rather than a raw exception.';

-- Self-check.
do $$
begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and tablename='documents' and indexname='documents_active_payment_source_uidx'
  ) then
    raise exception 'self-check: documents_active_payment_source_uidx missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='create_document') not like '%unique_violation%' then
    raise exception 'self-check: create_document does not catch unique_violation';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='create_document_with_payment') not like '%unique_violation%' then
    raise exception 'self-check: create_document_with_payment does not catch unique_violation';
  end if;
end $$;
