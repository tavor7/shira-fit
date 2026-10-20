-- Financial integrity: replace the destructive account-payment reversal with an auditable status.
--
-- Confirmed defect (read-only investigation, production): cancel_document(..., p_revert_payment=true) calls
-- _revert_document_payment, whose 'account_payment' branch does `delete from athlete_account_payments where id
-- = p_source_id` -- a physical row delete. The (kept, CANCELLED) document's source_id then points at nothing.
-- This violates the owner's Rule B ("the receipt must not reference a payment record that has been physically
-- deleted") and loses the original payment's historical traceability entirely.
--
-- Architecture decision (see the final report for the full comparison against a negative-amount reversal-ledger
-- row and against inventing a new accounting subsystem): add a nullable `reversed_at`/`reversed_by` pair to
-- athlete_account_payments itself -- a payment lifecycle status, not a new row. This is the SMALLEST change that
-- satisfies every required property:
--   - the original row (all its original values: amount_ils, payment_method, paid_at, note, payer_name) is
--     preserved exactly as it was, never rewritten -- full historical traceability, stronger than the existing
--     precedent for session payments (_revert_document_payment's session_payment branch nulls out amount_paid/
--     payment_method in place, which this migration does NOT touch or redesign -- see the final report, section 7,
--     for why that precedent is not a demonstrated defect and is left exactly as-is);
--   - excluding it from "collected" is a single added predicate (`reversed_at is null`) in every function that
--     already sums/lists athlete_account_payments -- no new join, no sign-handling, no amount_ils CHECK
--     (amount_ils > 0) conflict the way a negative reversal row would have caused;
--   - idempotent by construction: the UPDATE below is itself guarded by `where reversed_at is null`, so even a
--     direct, repeated call converges to "already reversed" with zero duplicate effect, independent of
--     cancel_document's own already_cancelled guard one level up;
--   - restates the original payment's effect at its original paid_at date/period (consistent with the existing
--     session-payment precedent, which also corrects in place rather than posting a dated reversal event in the
--     cancellation period -- chosen for consistency with that already-established behavior, not decided fresh);
--   - compatible with the planned subscription-payment feature without any special-casing: a future
--     `source_subscription_id`-tagged payment reverses through the exact same column and the exact same
--     _period_merged_athlete_finance predicate, with no separate implementation needed.
--
-- Verified before writing this migration (read-only, production):
--   - zero existing athlete_account_payments rows need backfilling (the column is new and defaults to null);
--   - the only consumers of athlete_account_payments.amount_ils as "money collected" are
--     _period_merged_athlete_finance (the balance authority), staff_list_received_payments (manager "received
--     payments" list + total) and staff_list_payments_without_receipt (manager "awaiting receipt" list) --
--     confirmed by reading every current function that selects from this table; all three are patched below.
--     delete_document(p_delete_payment=true) also deletes an account payment, but it is gated behind
--     `not receipt_settings.is_operational` (testing-mode only) and is out of this task's explicit scope (not
--     named in the investigation list); left untouched and flagged in the final report, not silently ignored.

alter table public.athlete_account_payments
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references public.profiles (user_id) on delete set null;

alter table public.athlete_account_payments
  drop constraint if exists athlete_account_payments_reversed_pair_chk;
alter table public.athlete_account_payments
  add constraint athlete_account_payments_reversed_pair_chk
  check ((reversed_at is null) = (reversed_by is null));

comment on column public.athlete_account_payments.reversed_at is
  'Set when this payment''s financial effect was reversed (via cancel_document(..., p_revert_payment=true)). The row itself is never deleted or rewritten -- every financial query must exclude reversed_at IS NOT NULL rows from "collected" totals.';

-- 1. _revert_document_payment: account_payment branch becomes a status update, not a delete. The session_payment
-- and cancellation_penalty branches are copied verbatim (unchanged) from the production definition below.
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_revert_document_payment') <> 1 then
    raise exception 'precondition: _revert_document_payment must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_revert_document_payment')
     <> '286f542b7a4976e47e6c65797adac661' then
    raise exception 'precondition: source of _revert_document_payment differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public._revert_document_payment(
  p_source_type public.document_source_type,
  p_source_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_source_id is null or p_source_type is null or p_source_type = 'manual' then
    return json_build_object('ok', true, 'reverted', false, 'reason', 'no_linked_payment');
  end if;

  case p_source_type
    when 'account_payment' then
      update public.athlete_account_payments
      set reversed_at = now(), reversed_by = auth.uid()
      where id = p_source_id and reversed_at is null;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found_or_already_reversed');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'account_payment');

    when 'session_payment' then
      update public.session_registrations
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'registration');
      end if;

      update public.session_manual_participants
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'manual');
      end if;
      return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');

    when 'cancellation_penalty' then
      update public.cancellations
      set penalty_collected_ils = 0
      where id = p_source_id
        and coalesce(penalty_collected_ils, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'cancellation_penalty');

    else
      return json_build_object('ok', true, 'reverted', false, 'reason', 'unsupported_source');
  end case;
end;
$$;

comment on function public._revert_document_payment(public.document_source_type, uuid) is
  'Reverses the financial effect of a payment whose receipt is being cancelled. Account payments are marked reversed_at/reversed_by (row preserved, never deleted) as of 2026-10-21 -- previously a hard delete. Session payments are cleared in place (unchanged, pre-existing behavior). Idempotent: a payment already reversed, or with nothing to reverse, returns reverted=false and makes no further change.';

-- 2. _period_merged_athlete_finance: exclude reversed account payments from "collected". This is the single
-- authoritative balance/expected-vs-collected function every finance screen and report reads from -- confirmed
-- by inspection to be the only place that sums athlete_account_payments.amount_ils into collected_account_ils.
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_period_merged_athlete_finance') <> 1 then
    raise exception 'precondition: _period_merged_athlete_finance must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_period_merged_athlete_finance')
     <> '3ffede98a66fe37b6f819dac181226a6' then
    raise exception 'precondition: source of _period_merged_athlete_finance differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public._period_merged_athlete_finance(p_start date, p_end date)
returns table(kind text, pid text, expected_ils numeric, collected_sessions_ils numeric, collected_account_ils numeric, collected_total_ils numeric, outstanding_ils numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with per_slot as (
    select
      'app'::text as kind,
      reg.user_id::text as pid,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)
      end)::numeric as exp_amt,
      coalesce(reg.amount_paid, 0)::numeric as coll_amt
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is true
    union all
    select
      'app'::text,
      reg.user_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)
      end)::numeric,
      coalesce(reg.amount_paid, 0)::numeric
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is false
      and reg.charge_no_show is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is false
      and m.charge_no_show is true
    union all
    select
      'app'::text,
      c.user_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, c.user_id), 0)
      end)::numeric,
      coalesce(c.penalty_collected_ils, 0)::numeric
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    left join public.session_registrations reg2
      on reg2.session_id = c.session_id and reg2.user_id = c.user_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg2.id
    where s.session_date between p_start and p_end
      and c.charged_full_price is true
    union all
    -- Subscription charges are additional debt-feed line items (recurring/proration/etc.),
    -- attributed to the billing period they were posted for. No separate "collected" side here:
    -- payment against a subscription charge is recorded as an athlete_account_payments row
    -- (already summed in acct_by_ath below), matching the plan's "debt-feed line items only" rule.
    -- Filtered by bp.period_start (not session_date, since a charge has no single session) — a
    -- charge surfaces in whichever p_start/p_end range contains its billing period's start date,
    -- as one lump sum, not smeared across the period's weeks.
    -- Netting (Phase 3, not written yet by this migration): a `reversal` row is expected to carry
    -- a NEGATIVE amount_ils equal to `-1 * ` the charge it reverses (via `reverses`), so that
    -- summing all subscription_charges rows for a payee/period nets to the corrected total with
    -- no double-count — e.g. +300 recurring, -300 reversal, +150 stop_proration nets to +150.
    -- This convention is not enforced by a CHECK constraint here; Phase 3's writer must honor it.
    select
      case when sc.payee_is_manual then 'manual' else 'app' end::text,
      sc.payee_id::text,
      sc.amount_ils::numeric,
      0::numeric
    from public.subscription_charges sc
    join public.subscription_billing_periods bp on bp.id = sc.billing_period_id
    where bp.period_start between p_start and p_end
  ),
  sess_by_ath as (
    select
      ps.kind,
      ps.pid,
      round(sum(ps.exp_amt)::numeric, 2) as expected_ils,
      round(sum(ps.coll_amt)::numeric, 2) as collected_sessions_ils
    from per_slot ps
    group by ps.kind, ps.pid
  ),
  acct_by_ath as (
    select
      case when a.payee_is_manual then 'manual' else 'app' end as kind,
      a.payee_id::text as pid,
      round(sum(a.amount_ils)::numeric, 2) as collected_account_ils
    from public.athlete_account_payments a
    where a.paid_at between p_start and p_end
      and a.reversed_at is null
    group by 1, 2
  ),
  ath_keys as (
    select kind, pid from sess_by_ath
    union
    select kind, pid from acct_by_ath
  )
  select
    k.kind,
    k.pid,
    coalesce(s.expected_ils, 0)::numeric as expected_ils,
    coalesce(s.collected_sessions_ils, 0)::numeric as collected_sessions_ils,
    coalesce(a.collected_account_ils, 0)::numeric as collected_account_ils,
    (coalesce(s.collected_sessions_ils, 0) + coalesce(a.collected_account_ils, 0))::numeric as collected_total_ils,
    round((
      coalesce(s.expected_ils, 0)
      - coalesce(s.collected_sessions_ils, 0)
      - coalesce(a.collected_account_ils, 0)
    )::numeric, 2) as outstanding_ils
  from ath_keys k
  left join sess_by_ath s on s.kind = k.kind and s.pid = k.pid
  left join acct_by_ath a on a.kind = k.kind and a.pid = k.pid;
$function$;

-- 3. The new receipt-protection guard also protects the new columns from a direct bypass attempt (setting
-- reversed_at/reversed_by on a STILL-actively-receipted row outside the normal cancel_document flow). The
-- legitimate flow (cancel_document always flips the document to CANCELLED first, in the same transaction,
-- before _revert_document_payment runs) is unaffected: by the time this UPDATE fires, _payment_has_active_document
-- already sees the document as CANCELLED, so the guard does not block it -- re-verified by a dedicated test.
create or replace function public._guard_receipted_account_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (new.amount_ils, new.payment_method, new.paid_at, new.payee_id, new.payee_is_manual, new.payer_name, new.note, new.reversed_at, new.reversed_by)
         is not distinct from
         (old.amount_ils, old.payment_method, old.paid_at, old.payee_id, old.payee_is_manual, old.payer_name, old.note, old.reversed_at, old.reversed_by) then
    return new;  -- no receipt-relevant field changed
  end if;
  if public._payment_has_active_document('account', old.id) then
    raise exception 'account_payment_locked_receipt_issued'
      using errcode = 'P0001',
            detail = 'A receipt has been issued for this account payment; it can no longer be modified or deleted. Cancel the receipt first if a correction is required.';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public._guard_receipted_account_payment() is
  'Refuses ANY change (including by a manager) to the receipt-relevant fields of an athlete_account_payments row, or deletion of its row, once an active receipt has been issued for it. Protected fields now include reversed_at/reversed_by (2026-10-21), closing a direct-client-bypass path for the new reversal mechanism; the legitimate cancel-then-revert flow is unaffected since the document is already cancelled by the time this fires.';

-- 4. _create_document_from_payment_row: a reversed account payment has no remaining financial effect and must
-- not be re-receipted (it would misrepresent money as collected that has been reversed).
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_create_document_from_payment_row') <> 1 then
    raise exception 'precondition: _create_document_from_payment_row must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_create_document_from_payment_row')
     <> '43d2d69c86bfdf9546414e0af0d52885' then
    raise exception 'precondition: source of _create_document_from_payment_row differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public._create_document_from_payment_row(p_row_id text)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_settings public.receipt_settings%rowtype;
  v_effective_vat_rate numeric(5,4);
  v_row record;
  v_source public.document_source_type;
  v_source_id uuid;
  v_customer_id uuid;
  v_doc_id uuid;
  v_doc_number text;
  v_net numeric(12, 2);
  v_vat numeric(12, 2);
  v_method public.document_payment_method;
  v_status public.document_status;
  v_service_type public.document_service_type;
  v_service_description text;
  v_profile_user_id uuid;
  v_manual_participant_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_customer_address text := '';
  v_customer_zip text := '';
  v_amount numeric(12, 2);
begin
  select * into v_row
  from (
    select
      'account'::text as row_kind,
      ('account:' || a.id::text) as row_id,
      a.id as record_id,
      a.payee_id,
      a.payee_is_manual,
      round(a.amount_ils::numeric, 2) as amount_ils,
      a.payment_method,
      a.note,
      null::uuid as session_id,
      null::date as session_date,
      null::time as session_start_time,
      null::text as session_slot_kind,
      null::int as max_participants,
      false as is_kickbox,
      null::text as coach_name
    from public.athlete_account_payments a
    where ('account:' || a.id::text) = p_row_id

    union all

    select
      'session_reg',
      ('session_reg:' || r.id::text),
      r.id,
      r.user_id,
      false,
      round(r.amount_paid::numeric, 2),
      r.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      case
        when r.attended is true then 'arrival'
        when r.charge_no_show is true then 'no_show'
        else 'session'
      end,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('session_reg:' || r.id::text) = p_row_id

    union all

    select
      'session_manual',
      ('session_manual:' || m.id::text),
      m.id,
      m.manual_participant_id,
      true,
      round(m.amount_paid::numeric, 2),
      m.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      case
        when m.attended is true then 'arrival'
        when m.charge_no_show is true then 'no_show'
        else 'session'
      end,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('session_manual:' || m.id::text) = p_row_id

    union all

    select
      'cancellation',
      ('cancellation:' || c.id::text),
      c.id,
      c.user_id,
      false,
      round(c.penalty_collected_ils::numeric, 2),
      c.payment_method,
      null::text,
      s.id,
      s.session_date,
      s.start_time,
      'cancellation',
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where ('cancellation:' || c.id::text) = p_row_id
  ) q
  limit 1;

  if not found then
    return json_build_object('ok', false, 'error', 'payment_not_found', 'row_id', p_row_id);
  end if;

  if public._payment_has_active_document(v_row.row_kind, v_row.record_id) then
    return json_build_object('ok', false, 'error', 'document_already_exists', 'row_id', p_row_id);
  end if;

  if v_row.row_kind = 'account' and exists (
    select 1 from public.athlete_account_payments where id = v_row.record_id and reversed_at is not null
  ) then
    return json_build_object('ok', false, 'error', 'payment_reversed', 'row_id', p_row_id);
  end if;

  v_source := public._payment_document_source_type(v_row.row_kind);
  v_source_id := v_row.record_id;

  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then
    return json_build_object('ok', false, 'error', 'digital_receipts_disabled', 'row_id', p_row_id);
  end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then
    return json_build_object('ok', false, 'error', 'business_id_required', 'row_id', p_row_id);
  end if;

  v_method := public._map_session_payment_to_document_method(v_row.payment_method);
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;

  if v_row.row_kind = 'account' then
    v_service_type := 'other';
    v_service_description := coalesce(nullif(trim(v_row.note), ''), 'תשלום בחשבון');
  else
    v_service_type := public._service_type_from_session(v_row.max_participants, v_row.is_kickbox);
    v_service_description := trim(both ' ·' from concat_ws(
      ' · ',
      v_row.coach_name,
      to_char(v_row.session_date, 'DD/MM/YYYY'),
      case v_row.session_slot_kind
        when 'no_show' then 'אי הגעה'
        when 'cancellation' then 'ביטול מאוחר'
        else null
      end
    ));
  end if;

  if v_row.payee_is_manual then
    v_manual_participant_id := v_row.payee_id;
    v_profile_user_id := null;
  else
    v_profile_user_id := v_row.payee_id;
    v_manual_participant_id := null;
  end if;

  v_amount := v_row.amount_ils;

  select coalesce(p.full_name, m.full_name, 'לקוח'), coalesce(p.phone, m.phone),
         coalesce(p.address, ''), coalesce(p.zip_code, '')
  into v_customer_name, v_customer_phone, v_customer_address, v_customer_zip
  from (select 1) x
  left join public.profiles p on p.user_id = v_profile_user_id
  left join public.manual_participants m on m.id = v_manual_participant_id;

  v_customer_email := public._resolve_customer_email(v_profile_user_id, null);

  v_effective_vat_rate := case when v_settings.vat_enabled then v_settings.vat_rate else 0 end;
  select net_amount, vat_amount into v_net, v_vat
  from public._document_vat_breakdown(v_amount, v_effective_vat_rate);

  v_customer_id := public._upsert_customer_from_payee(
    v_customer_name, v_customer_email, v_customer_phone,
    v_profile_user_id, v_manual_participant_id,
    v_customer_address, v_customer_zip
  );
  v_doc_number := public._allocate_document_number();

  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone, customer_address, customer_zip_code,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by
  )
  values (
    v_doc_number, v_customer_id, v_amount, v_net, v_vat, v_effective_vat_rate,
    v_method, v_service_type, v_service_description, null,
    v_status, v_customer_name, v_customer_email, v_customer_phone,
    v_customer_address, v_customer_zip,
    v_settings.business_name, v_settings.business_id, v_settings.address,
    v_settings.phone, v_settings.email,
    v_source, v_source_id, auth.uid()
  )
  returning id into v_doc_id;

  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object(
    'document_number', v_doc_number,
    'gross_amount', v_amount,
    'row_id', p_row_id,
    'source_type', v_source,
    'source_id', v_source_id
  ));

  return json_build_object(
    'ok', true,
    'row_id', p_row_id,
    'document_id', v_doc_id,
    'document_number', v_doc_number,
    'status', v_status,
    'needs_pdf', true
  );
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'document_already_exists', 'row_id', p_row_id);
  when others then
    return json_build_object('ok', false, 'error', SQLERRM, 'row_id', p_row_id);
end;
$function$;

-- 5. staff_list_payments_without_receipt: a reversed account payment has nothing left to receipt.
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_list_payments_without_receipt') <> 1 then
    raise exception 'precondition: staff_list_payments_without_receipt must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_list_payments_without_receipt')
     <> 'f7d54a86aaa632ac4f953eefe239880d' then
    raise exception 'precondition: source of staff_list_payments_without_receipt differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.staff_list_payments_without_receipt(p_date_start date default null::date, p_date_end date default null::date, p_limit integer default 500, p_offset integer default 0)
returns json
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_floor date := '2026-06-14'::date;
  v_start date := greatest(coalesce(p_date_start, v_floor), v_floor);
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_rows json;
  v_total_count bigint;
  v_total_amount numeric(14, 2);
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  with unified as (
    select
      'account'::text as row_kind,
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
      a.paid_at::timestamptz as paid_at,
      a.created_at,
      null::int as max_participants,
      false as is_kickbox,
      null::text as coach_name
    from public.athlete_account_payments a
    where a.amount_ils > 0
      and a.reversed_at is null
      and public.normalize_payment_method_key(a.payment_method) <> 'discount'
      and a.paid_at >= v_start
      and (p_date_end is null or a.paid_at <= p_date_end)

    union all

    select
      'session_reg',
      'session',
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
      s.session_date::timestamptz,
      coalesce(r.payment_recorded_at, s.session_date::timestamptz),
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where r.status = 'active'
      and coalesce(r.amount_paid, 0) > 0
      and (r.attended is true or (r.attended is false and r.charge_no_show is true))
      and s.session_date >= v_start
      and (p_date_end is null or s.session_date <= p_date_end)

    union all

    select
      'session_manual',
      'session',
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
      s.session_date::timestamptz,
      coalesce(m.payment_recorded_at, s.session_date::timestamptz),
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where coalesce(m.amount_paid, 0) > 0
      and (m.attended is true or (m.attended is false and m.charge_no_show is true))
      and s.session_date >= v_start
      and (p_date_end is null or s.session_date <= p_date_end)

    union all

    select
      'cancellation',
      'session',
      ('cancellation:' || c.id::text),
      c.id,
      s.id,
      s.session_date,
      s.start_time,
      'cancellation',
      c.user_id,
      false,
      round(c.penalty_collected_ils::numeric, 2),
      c.payment_method,
      null::text,
      s.session_date::timestamptz,
      c.cancelled_at,
      s.max_participants,
      coalesce(s.is_kickbox, false),
      cp.full_name
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    join public.profiles cp on cp.user_id = s.coach_id
    where c.charged_full_price is true
      and coalesce(c.penalty_collected_ils, 0) > 0
      and s.session_date >= v_start
      and (p_date_end is null or s.session_date <= p_date_end)
  ),
  pending as (
    select u.*
    from unified u
    where not public._payment_has_active_document(u.row_kind, u.record_id)
  ),
  enriched as (
    select
      p.row_kind,
      p.source,
      p.row_id,
      p.record_id,
      p.session_id,
      p.session_date,
      p.session_start_time::text as session_start_time,
      p.session_slot_kind,
      p.payee_id,
      p.payee_is_manual,
      p.amount_ils,
      p.payment_method,
      p.note,
      p.paid_at,
      p.created_at,
      p.coach_name,
      case
        when p.row_kind = 'account' then 'other'::public.document_service_type
        else public._service_type_from_session(p.max_participants, p.is_kickbox)
      end as service_type,
      public._map_session_payment_to_document_method(p.payment_method) is null as needs_payment_method,
      coalesce(
        case when p.payee_is_manual then mp.full_name else pr.full_name end,
        'לקוח'
      ) as payee_name,
      case when p.payee_is_manual then mp.phone else pr.phone end as payee_phone
    from pending p
    left join public.profiles pr on pr.user_id = p.payee_id and not p.payee_is_manual
    left join public.manual_participants mp on mp.id = p.payee_id and p.payee_is_manual
  ),
  totals as (
    select
      count(*)::bigint as total_count,
      coalesce(round(sum(amount_ils)::numeric, 2), 0) as total_amount
    from enriched
  ),
  page as (
    select *
    from enriched
    order by paid_at desc, created_at desc, row_id desc
    limit v_limit
    offset v_offset
  )
  select
    coalesce(
      (
        select json_agg(row_to_json(p))
        from (
          select * from page
          order by paid_at desc, created_at desc, row_id desc
        ) p
      ),
      '[]'::json
    ),
    t.total_count,
    t.total_amount
  into v_rows, v_total_count, v_total_amount
  from totals t;

  return json_build_object(
    'ok', true,
    'payments', v_rows,
    'total_count', v_total_count,
    'total_amount', v_total_amount
  );
exception
  when others then
    return json_build_object('ok', false, 'error', SQLERRM);
end;
$function$;

-- 6. staff_list_received_payments: exclude reversed account payments from both the list and the "total_received"
-- figure shown to managers -- a reversed payment no longer represents money actually collected.
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_list_received_payments') <> 1 then
    raise exception 'precondition: staff_list_received_payments must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_list_received_payments')
     <> '77bca7631549ac6a84d29713a5b3840a' then
    raise exception 'precondition: source of staff_list_received_payments differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.staff_list_received_payments(p_date_start date default null::date, p_date_end date default null::date, p_payee_id uuid default null::uuid, p_payee_is_manual boolean default null::boolean, p_payee_filters jsonb default null::jsonb, p_payment_method text default null::text, p_limit integer default 500, p_offset integer default 0)
returns json
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
  if not public.is_manager(v_uid) then
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
      and a.reversed_at is null
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
      c.payment_method,
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
      and (
        v_method is null
        or public.normalize_payment_method_key(c.payment_method) = v_method
      )
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
$function$;

-- Self-check.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='athlete_account_payments' and column_name in ('reversed_at','reversed_by')
    having count(*) = 2
  ) then
    raise exception 'self-check: reversed_at/reversed_by columns missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_revert_document_payment') like '%delete from public.athlete_account_payments%' then
    raise exception 'self-check: _revert_document_payment still hard-deletes account payments';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_period_merged_athlete_finance') not like '%a.reversed_at is null%' then
    raise exception 'self-check: _period_merged_athlete_finance does not exclude reversed payments';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_create_document_from_payment_row') not like '%payment_reversed%' then
    raise exception 'self-check: _create_document_from_payment_row does not reject reversed payments';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='staff_list_payments_without_receipt') not like '%a.reversed_at is null%' then
    raise exception 'self-check: staff_list_payments_without_receipt does not exclude reversed payments';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='staff_list_received_payments') not like '%a.reversed_at is null%' then
    raise exception 'self-check: staff_list_received_payments does not exclude reversed payments';
  end if;
end $$;
