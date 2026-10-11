-- Authorization: restrict coaches from studio-wide financial and customer data (coach authorization review).
--
-- Intended model: managers have full access to financial records, payments, receipts, billing and financial reports.
-- Coaches work with sessions, attendance and rosters (including recording a payment at check-in on THEIR OWN sessions,
-- which set_registration_attendance / set_manual_participant_attendance already scope to the session's coach) and may read
-- prices (the amount due shown at check-in). Coaches get no studio-wide ledger, receipts, customer records, receipt
-- administration, financial reports or price administration.
--
-- Before this migration (verified on an isolated copy of production with real coach / manager / athlete / anon sessions over
-- PostgREST), any coach could, through the REST API and in the coach app's participant-history screen:
--   * read, insert, update and DELETE every athlete account payment (athlete_account_payments);
--   * read every receipt / financial document, its audit events, external receipts, receipt settings and every customer
--     record (names, emails, phones, addresses);
--   * issue receipts (create_document, create_document_with_payment), cancel them, change their payment method, mark /
--     unmark payments as externally receipted, and list all documents, all received payments, payments without receipts
--     and session receipt rosters;
--   * read every receipt PDF in storage;
--   * edit studio-wide session prices, per-athlete prices, and per-participant session rates on ANY session.
--
-- Changes (all least-privilege, no data touched):
--   1. RLS: athlete_account_payments, documents, document_events, customers, external_manual_receipts, receipt_settings
--      become manager-only. Price tables keep staff SELECT (amount due at check-in) but writes become manager-only;
--      per-participant session rates (session_roster_slot_prices) are writable by managers and by the coach of that session.
--   2. RPC guards: the 12 finance RPCs that admitted coaches (is_coach_or_manager) now require is_manager. Each body is
--      changed by exactly that one call; the migration aborts unless the deployed source is byte-identical to the reviewed
--      one (md5 precondition), so a drifted function is never overwritten.
--   3. Storage: receipt PDFs (bucket document-pdfs) readable by managers only.
-- Unchanged on purpose: attendance + payment-at-check-in on own sessions, price reads, coach pay-rate self-service
-- (coach_capacity_pricing, owner decision), profiles read (athlete details for coaching), all athlete self-service.

-- 1. RLS ---------------------------------------------------------------------------------------------------------------
drop policy if exists athlete_account_payments_staff_select on public.athlete_account_payments;
drop policy if exists athlete_account_payments_staff_write on public.athlete_account_payments;
create policy athlete_account_payments_manager_select on public.athlete_account_payments
  for select using (public.is_manager(auth.uid()));
create policy athlete_account_payments_manager_write on public.athlete_account_payments
  for all using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

drop policy if exists documents_staff_select on public.documents;
create policy documents_manager_select on public.documents for select using (public.is_manager(auth.uid()));

drop policy if exists document_events_staff_select on public.document_events;
create policy document_events_manager_select on public.document_events for select using (public.is_manager(auth.uid()));

drop policy if exists customers_staff_select on public.customers;
create policy customers_manager_select on public.customers for select using (public.is_manager(auth.uid()));

drop policy if exists external_manual_receipts_staff_select on public.external_manual_receipts;
create policy external_manual_receipts_manager_select on public.external_manual_receipts
  for select using (public.is_manager(auth.uid()));

drop policy if exists receipt_settings_staff_select on public.receipt_settings;
create policy receipt_settings_manager_select on public.receipt_settings for select using (public.is_manager(auth.uid()));

drop policy if exists session_capacity_pricing_staff_write on public.session_capacity_pricing;
create policy session_capacity_pricing_manager_write on public.session_capacity_pricing
  for all using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

drop policy if exists athlete_session_capacity_pricing_staff_write on public.athlete_session_capacity_pricing;
create policy athlete_session_capacity_pricing_manager_write on public.athlete_session_capacity_pricing
  for all using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

drop policy if exists session_roster_slot_prices_staff_write on public.session_roster_slot_prices;
create policy session_roster_slot_prices_manager_or_session_coach_write on public.session_roster_slot_prices
  for all
  using (
    public.is_manager(auth.uid())
    or exists (select 1 from public.training_sessions s where s.id = session_roster_slot_prices.session_id and s.coach_id = auth.uid())
  )
  with check (
    public.is_manager(auth.uid())
    or exists (select 1 from public.training_sessions s where s.id = session_roster_slot_prices.session_id and s.coach_id = auth.uid())
  );

-- 2. RPC guards ---------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      ('cancel_document',                     'de085d9a06b71fdb7d80d7d16965d1be'),
      ('create_document',                     'bdb608d575eb81cc675950c13490ddcd'),
      ('create_document_with_payment',        'df89849f92881dc55504ebcab6586a9c'),
      ('get_receipt_settings',                '5f01e599e27524012bcfba6ee40bc68a'),
      ('has_later_issued_receipt',            '9a16b05930a0526c570db359cd2efc1a'),
      ('list_documents',                      'ba474b1a25825cb348a708141924248e'),
      ('mark_payment_receipt_external',       '00097b254cafdac92a7b90b4a4a6a743'),
      ('set_document_payment_method',         'd73d9c7653181be507741e2858ae978d'),
      ('staff_list_payments_without_receipt', '0e53232838ceb8f5ec754ce9c82ead07'),
      ('staff_list_received_payments',        'afd6e26db3a9165fb53210c92c6ac480'),
      ('staff_session_receipt_roster',        'efe9496d0be9f3d31f4f8d9c144f9509'),
      ('unmark_payment_receipt_external',     '31111375b3ab762d6860803d6dfca40a')
    ) v(fn, src_md5)
  loop
    if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.fn) <> 1 then
      raise exception 'precondition: % must have exactly one overload', r.fn;
    end if;
    if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = r.fn) <> r.src_md5 then
      raise exception 'precondition: source of % differs from the reviewed version; refusing to change it', r.fn;
    end if;
    if (select (length(prosrc) - length(replace(prosrc, 'is_coach_or_manager(', ''))) / length('is_coach_or_manager(')
        from pg_proc where pronamespace = 'public'::regnamespace and proname = r.fn) <> 1 then
      raise exception 'precondition: % must contain exactly one is_coach_or_manager( guard', r.fn;
    end if;
    select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fn;
    -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
    execute replace(v_def, 'is_coach_or_manager(', 'is_manager(');
  end loop;
end $$;

-- 3. Storage: receipt PDFs --------------------------------------------------------------------------------------------
-- (Guarded so the migration also runs on databases without the storage schema, e.g. scratch test databases.)
do $st$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists document_pdfs_staff_read on storage.objects';
    execute $p$create policy document_pdfs_manager_read on storage.objects
      for select using (bucket_id = 'document-pdfs' and public.is_manager(auth.uid()))$p$;
  end if;
end $st$;

-- Self-check -----------------------------------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['cancel_document','create_document','create_document_with_payment','get_receipt_settings',
    'has_later_issued_receipt','list_documents','mark_payment_receipt_external','set_document_payment_method',
    'staff_list_payments_without_receipt','staff_list_received_payments','staff_session_receipt_roster','unmark_payment_receipt_external']
  loop
    if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = v_fn
               and (prosrc like '%is_coach_or_manager(%' or prosrc not like '%is_manager(%' or not prosecdef)) then
      raise exception 'self-check: % is not manager-only definer', v_fn;
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public'
             and tablename in ('athlete_account_payments','documents','document_events','customers','external_manual_receipts','receipt_settings')
             and coalesce(qual, '') || coalesce(with_check, '') like '%is_coach_or_manager%') then
    raise exception 'self-check: a financial table still admits coaches';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'document_pdfs_staff_read') then
    raise exception 'self-check: staff read policy on receipt PDFs still present';
  end if;
  -- the coach's own operational paths stay open
  if not has_function_privilege('authenticated', 'public.set_registration_attendance(uuid, uuid, text, text, numeric, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: attendance entry point lost EXECUTE';
  end if;
end $$;
