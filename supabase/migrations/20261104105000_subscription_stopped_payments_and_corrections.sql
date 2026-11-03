-- Owner decisions of 2026-11-03: payments after a stop, and receipt-locked sessions after a deletion.
--
-- Payments after a stop: a stopped subscription can receive money up to what it still owes. Its status, billing, coverage
-- and allowance are untouched; the payment is an ordinary subscription payment, reversible like any other.
--
-- Receipt-locked sessions: deleting a subscription still moves its covered sessions to regular price, but a session with
-- receipt history waits for a manager's decision, recorded here. This table holds decisions, not money: applying one moves
-- the session to the regular price, which is what Reports and balances read, the same as any other repriced session.
-- Receipts, documents and payments are never read for change here. Moving a session to the regular price can only raise
-- what is expected, so no credit note or other document is produced. Money collected later gets its receipt the normal way.
--
-- Also: a penalty already charged at the regular price stays at that price if a covered booking is later cancelled.
--
-- Changes no existing row.

create table if not exists public.subscription_deletion_corrections (
  id uuid primary key default gen_random_uuid(),
  coverage_id uuid unique references public.subscription_registration_coverage(id) on delete set null,
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  delete_event_id uuid references public.subscription_impact_events(id) on delete restrict,
  registration_id uuid,
  manual_participant_id uuid,
  session_id uuid,
  session_date date not null,
  slot_state text not null,
  regular_price_ils numeric(12, 2) not null,
  amount_paid_ils numeric(12, 2) not null,
  receipts jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'applied_regular_price', 'kept_covered')),
  decision_reason text,
  decided_by uuid references public.profiles(user_id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint subscription_deletion_corrections_decided_chk
    check ((status = 'pending') = (decided_at is null) and (status = 'pending' or decision_reason is not null))
);

create index if not exists subscription_deletion_corrections_pending_idx
  on public.subscription_deletion_corrections (created_at) where status = 'pending';

alter table public.subscription_deletion_corrections enable row level security;
revoke all on public.subscription_deletion_corrections from public, anon, authenticated;
grant select on public.subscription_deletion_corrections to authenticated;
drop policy if exists subscription_deletion_corrections_manager_select on public.subscription_deletion_corrections;
create policy subscription_deletion_corrections_manager_select on public.subscription_deletion_corrections
  for select to authenticated using (public.is_manager((select auth.uid())));

-- Decisions are history: a decided row cannot change, and no row can be removed.
create or replace function public._subscription_corrections_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'subscription_record_immutable' using errcode = 'P0001', detail = 'Correction records cannot be deleted.';
  end if;
  if old.status <> 'pending' then
    if (new.status, new.decision_reason, new.decided_by, new.decided_at) is distinct from (old.status, old.decision_reason, old.decided_by, old.decided_at) then
      raise exception 'subscription_correction_already_decided' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_corrections_guard on public.subscription_deletion_corrections;
create trigger subscription_corrections_guard
  before update or delete on public.subscription_deletion_corrections
  for each row execute function public._subscription_corrections_guard();

create or replace function public._subscription_outstanding(p_subscription_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select sum(c.amount_ils) from public.subscription_charges c where c.subscription_id = p_subscription_id), 0)
       - coalesce((select sum(a.amount_ils) from public.athlete_account_payments a
                   where a.source_subscription_id = p_subscription_id and a.reversed_at is null), 0);
$$;

-- Add Payment also offers a stopped subscription, while it still owes.
create or replace function public.subscription_payment_target(p_payee_id uuid, p_payee_is_manual boolean, p_paid_at date)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where public.is_manager(auth.uid())
    and s.payee_id = p_payee_id and s.payee_is_manual = p_payee_is_manual and s.deleted_at is null
    and (
      case when v.stopped_effective_date is not null
                and (p_paid_at >= v.stopped_effective_date or public._studio_today_date() >= v.stopped_effective_date)
           then p_paid_at <= public._studio_today_date() and public._subscription_outstanding(s.id) > 0
           else public._subscription_payment_eligible(s.id, p_paid_at)
      end
    )
  order by s.created_at desc
  limit 1;
$$;

-- What the delete flow reads, now with each session's receipts.
drop function if exists public._subscription_delete_history(uuid);
create function public._subscription_delete_history(p_subscription_id uuid)
returns table (
  coverage_id uuid, registration_id uuid, manual_participant_id uuid, session_id uuid, session_date date, start_time time,
  slot_state text, regular_price_ils numeric, amount_paid_ils numeric, has_receipt boolean, receipts jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id, c.registration_id, c.manual_participant_id, ts.id, ts.session_date, ts.start_time,
    st.state,
    coalesce(public.session_billing_price_ils(ts.id, r.user_id, m.manual_participant_id), 0),
    coalesce(r.amount_paid, m.amount_paid, 0) + coalesce(x.penalty_collected_ils, 0),
    case when r.id is not null then public._payment_has_any_document('session_reg', r.id)
         else public._payment_has_any_document('session_manual', m.id) end
      or (x.id is not null and public._payment_has_any_document('cancellation', x.id)),
    coalesce((
      select jsonb_agg(jsonb_build_object('number', d.document_number, 'status', d.status, 'amount_ils', d.gross_amount) order by d.created_at)
      from public.documents d
      where d.source_id in (r.id, m.id, x.id)
        and d.source_type in ('session_payment'::public.document_source_type, 'cancellation_penalty'::public.document_source_type)
    ), '[]'::jsonb)
    || coalesce((
      select jsonb_agg(jsonb_build_object('number', null, 'status', 'external', 'amount_ils', null))
      from public.external_manual_receipts e
      where e.record_id in (r.id, m.id, x.id)
    ), '[]'::jsonb)
  from public.subscription_registration_coverage c
  left join public.session_registrations r on r.id = c.registration_id
  left join public.session_manual_participants m on m.id = c.manual_participant_id
  join public.training_sessions ts on ts.id = coalesce(r.session_id, m.session_id)
  left join public.cancellations x on x.session_id = r.session_id and x.user_id = r.user_id and x.charged_full_price is true
  cross join lateral (
    select public._subscription_slot_state(r.status, coalesce(r.attended, m.attended), coalesce(r.charge_no_show, m.charge_no_show),
                                           x.id is not null, public._session_has_ended(ts)) as state
  ) st
  where c.subscription_id = p_subscription_id
    and c.covered
    and st.state in ('attended', 'penalty', 'unmarked')
  order by ts.session_date, ts.start_time;
$$;

CREATE OR REPLACE FUNCTION public.subscription_reconcile_week(p_subscription_id uuid, p_week_start date, p_tier subscription_tier)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_limit int;
  v_covered_count int := 0;
  v_ctx public.subscription_effective_context_result;
  v_covered boolean;
  v_reason public.subscription_non_coverage_reason;
  r record;
begin
  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier));

  v_limit := public.subscription_effective_weekly_limit(v_payee_id, v_payee_is_manual, p_tier, p_week_start);

  for r in
    select g.*, ts.session_date, public._session_has_ended(ts) as ended,
           cov.id as coverage_id, cov.subscription_id as was_subscription_id,
           exists (select 1 from public.subscription_deletion_corrections k
                   where k.coverage_id = cov.id and k.status in ('pending', 'kept_covered')) as correction_hold, cov.covered as was_covered, cov.non_coverage_reason as was_reason,
           public._subscription_slot_state(g.status, g.attended, g.charge_no_show, g.charged_cancellation, public._session_has_ended(ts)) as state
    from (
      select reg.id as registration_id, null::uuid as manual_row_id, reg.session_id, reg.registered_at as created_at,
             reg.status, reg.attended, reg.charge_no_show,
             exists (select 1 from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id and c.charged_full_price is true) as charged_cancellation,
             coalesce(reg.amount_paid, 0) + coalesce((select c.penalty_collected_ils from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id), 0) as collected
      from public.session_registrations reg
      where not v_payee_is_manual and reg.user_id = v_payee_id
      union all
      select null, m.id, m.session_id, m.added_at, null, m.attended, m.charge_no_show, false, coalesce(m.amount_paid, 0)
      from public.session_manual_participants m
      where v_payee_is_manual and m.manual_participant_id = v_payee_id
    ) g
    join public.training_sessions ts on ts.id = g.session_id
    left join public.subscription_registration_coverage cov
      on cov.registration_id = g.registration_id or cov.manual_participant_id = g.manual_row_id
    where ts.session_date between p_week_start and p_week_start + 6
      and public.subscription_tier_for_capacity(ts.max_participants) = p_tier
    order by g.created_at asc, coalesce(g.registration_id, g.manual_row_id) asc
  loop
    -- A cancelled booking holds nothing and is left as recorded.
    continue when r.state = 'cancelled';
    -- History stays as it is: coverage is never created for a session that already ended.
    continue when r.coverage_id is null and r.ended;
    -- A receipt-locked session awaiting, or kept by, a manager's correction decision changes only through that decision.
    continue when r.correction_hold;

    v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

    if r.was_reason = 'subscription_deleted' and (r.ended or v_ctx.subscription_id is null) then
      -- Deleting a subscription moved this session to regular price; attendance edits must not undo that.
      v_covered := false;
      v_reason := 'subscription_deleted';
    elsif r.state = 'released' then
      v_covered := false;
      v_reason := 'no_show_released';
    elsif r.was_covered and r.ended and exists (
      select 1 from public.subscription_versions sv
      where sv.subscription_id = r.was_subscription_id and sv.stopped_effective_date = r.session_date
    ) then
      -- A session on the stop date that had already taken place stays as it was.
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    elsif v_ctx.subscription_id is null or not v_ctx.in_window then
      v_covered := false;
      v_reason := case when r.was_reason = 'subscription_ended' then 'subscription_ended'::public.subscription_non_coverage_reason
                       else 'not_subscribed'::public.subscription_non_coverage_reason end;
    elsif v_ctx.is_frozen then
      v_covered := false;
      v_reason := 'frozen';
    elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
      v_covered := false;
      v_reason := 'tier_not_included';
    elsif coalesce(r.was_covered, false) is false and r.was_reason = 'allowance_exceeded' and r.state = 'penalty' then
      -- A penalty charged at the regular price stays that way: another booking being cancelled does not make it free.
      v_covered := false;
      v_reason := 'allowance_exceeded';
    elsif v_covered_count >= v_limit then
      v_covered := false;
      v_reason := 'allowance_exceeded';
    elsif coalesce(r.was_covered, false) is false and r.collected > 0 then
      -- Money was already taken for this session at the regular price. A slot freeing up later must not silently turn
      -- that into an unexplained credit.
      v_covered := false;
      v_reason := 'paid_at_regular_price';
    else
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    end if;

    if r.registration_id is not null then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason);
    else
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, null, r.manual_row_id,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason);
    end if;
  end loop;
end;
$function$;
CREATE OR REPLACE FUNCTION public.record_subscription_payment(p_subscription_id uuid, p_amount_ils numeric, p_payment_method text, p_payer_name text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_paid_at date DEFAULT NULL::date, p_client_request_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sub record;
  v_existing_id uuid;
  v_payment_id uuid;
  v_paid_at date;
  v_today date := public._studio_today_date();
  v_stopped date;
  v_outstanding numeric;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- Idempotency fast path: a retry with the same token that already succeeded returns the
  -- existing payment rather than erroring or duplicating. Checked before the lock -- a pure read
  -- against a unique index, no race with delete_subscription to serialize against yet.
  if p_client_request_id is not null then
    select id into v_existing_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    if found then
      return json_build_object('ok', true, 'payment_id', v_existing_id, 'duplicate', true);
    end if;
  end if;

  if p_subscription_id is null then
    return json_build_object('ok', false, 'error', 'invalid_subscription');
  end if;

  -- Same advisory lock delete_subscription takes, keyed by subscription id: whichever of the two
  -- calls commits first is authoritative for what the other observes once it proceeds past here.
  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select s.id, s.payee_id, s.payee_is_manual, s.deleted_at into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;
  if v_sub.deleted_at is not null then
    return json_build_object('ok', false, 'error', 'subscription_deleted');
  end if;

  if p_amount_ils is null or p_amount_ils <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_payment_method is null or btrim(p_payment_method) = '' then
    return json_build_object('ok', false, 'error', 'invalid_payment_method');
  end if;

  v_paid_at := coalesce(p_paid_at, public._studio_today_date());

  select sv.stopped_effective_date into v_stopped
  from public.subscription_versions sv
  where sv.subscription_id = v_sub.id and sv.effective_to is null;

  if v_stopped is not null and (v_paid_at >= v_stopped or v_today >= v_stopped) then
    -- A stopped subscription can still receive money it is owed, up to what it is owed. The admin lock taken above
    -- serializes this check against other payments. Nothing here touches its status, billing or coverage.
    if v_paid_at > v_today then
      return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
    end if;
    v_outstanding := public._subscription_outstanding(v_sub.id);
    if v_outstanding <= 0 then
      return json_build_object('ok', false, 'error', 'no_outstanding_balance');
    end if;
    if p_amount_ils > v_outstanding then
      return json_build_object('ok', false, 'error', 'amount_exceeds_outstanding', 'outstanding_ils', v_outstanding);
    end if;
  elsif not public._subscription_payment_eligible(v_sub.id, v_paid_at) then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
  end if;

  begin
    insert into public.athlete_account_payments (
      payee_id, payee_is_manual, amount_ils, payment_method, payer_name, note, paid_at,
      source_subscription_id, client_request_id
    ) values (
      v_sub.payee_id, v_sub.payee_is_manual, p_amount_ils, p_payment_method, p_payer_name, p_note, v_paid_at,
      v_sub.id, p_client_request_id
    )
    returning id into v_payment_id;
  exception when unique_violation then
    -- A concurrent retry with the same client_request_id raced us; converge on its row.
    select id into v_payment_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', true);
  end;

  return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', false);
end;
$function$;
CREATE OR REPLACE FUNCTION public._subscription_delete_impact_json(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub public.subscriptions%rowtype;
  v_history jsonb;
  v_future jsonb;
  v_fingerprint text;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'coverage_id', h.coverage_id, 'registration_id', h.registration_id, 'manual_participant_id', h.manual_participant_id,
      'session_id', h.session_id, 'session_date', h.session_date, 'start_time', h.start_time, 'slot_state', h.slot_state,
      'regular_price_ils', h.regular_price_ils, 'amount_paid_ils', h.amount_paid_ils, 'has_receipt', h.has_receipt,
      'receipts', h.receipts,
      'will_reprice', not h.has_receipt,
      -- Only attended sessions and penalties become debt. An unmarked session becomes debt if attendance is marked later.
      'new_debt_ils', case when not h.has_receipt and h.slot_state in ('attended', 'penalty') then h.regular_price_ils else 0 end
    ) order by h.session_date, h.start_time), '[]'::jsonb),
    md5(coalesce(string_agg(h.coverage_id::text || ':' || h.regular_price_ils::text || ':' || h.has_receipt::text, ',' order by h.coverage_id), ''))
  into v_history, v_fingerprint
  from public._subscription_delete_history(p_subscription_id) h;

  v_future := public.subscription_future_registrations_impact(p_subscription_id, public._studio_today_date());

  return jsonb_build_object(
    'history_sessions', v_history,
    'future_registrations', v_future,
    'future_registrations_count', jsonb_array_length(v_future),
    'new_debt_ils', (select coalesce(sum((e->>'new_debt_ils')::numeric), 0) from jsonb_array_elements(v_history) e),
    'receipt_locked_count', (select count(*) from jsonb_array_elements(v_history) e where (e->>'has_receipt')::boolean),
    'repriced_count', (select count(*) from jsonb_array_elements(v_history) e where not (e->>'has_receipt')::boolean),
    'correction_debt_if_applied_ils', (select coalesce(sum((e->>'regular_price_ils')::numeric), 0) from jsonb_array_elements(v_history) e
                                       where (e->>'has_receipt')::boolean and e->>'slot_state' in ('attended', 'penalty')),
    'charges_to_reverse_ils', (
      select coalesce(sum(c.amount_ils), 0) from public.subscription_charges c
      where c.subscription_id = p_subscription_id and c.charge_type <> 'reversal'
        and not exists (select 1 from public.subscription_charges rv where rv.charge_type = 'reversal' and rv.reverses = c.id)
    ),
    'blocking_payments_ils', (
      select coalesce(sum(a.amount_ils), 0) from public.athlete_account_payments a
      where a.source_subscription_id = p_subscription_id and a.reversed_at is null
    ),
    'blocking_payments_count', (
      select count(*) from public.athlete_account_payments a
      where a.source_subscription_id = p_subscription_id and a.reversed_at is null
    ),
    'payee_discounts_ils', (
      select coalesce(sum(a.amount_ils), 0) from public.athlete_account_payments a
      where a.payee_id = v_sub.payee_id and a.payee_is_manual = v_sub.payee_is_manual and a.reversed_at is null
        and public.normalize_payment_method_key(a.payment_method) = 'discount'
    ),
    'fingerprint', v_fingerprint
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.delete_subscription_with_future_registrations(p_subscription_id uuid, p_future_registration_action text DEFAULT NULL::text, p_confirmed boolean DEFAULT false, p_expected_future_registration_ids uuid[] DEFAULT NULL::uuid[], p_expected_future_manual_participant_ids uuid[] DEFAULT NULL::uuid[], p_expected_impact_fingerprint text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_has_payment boolean;
  v_source_id uuid;
  v_reversed_count int := 0;
  v_reversed_total numeric(12, 2) := 0;
  v_cutoff date;
  v_future_impact jsonb;
  v_impact jsonb;
  v_future_resolved int := 0;
  v_repriced int := 0;
  v_locked int := 0;
  v_event_id uuid;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_future_registration_action is not null and p_future_registration_action not in ('remove', 'charge_regular_price') then
    return json_build_object('ok', false, 'error', 'invalid_future_registration_action');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select deleted_at into v_deleted_at
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Idempotent no-op: never re-check payments or re-reverse charges on a repeated call.
  if v_deleted_at is not null then
    return json_build_object('ok', true, 'action', 'already_deleted');
  end if;

  -- The owner-approved rule: ANY valid (unreversed) payment -- including a partial one -- blocks deletion outright.
  select exists (
    select 1 from public.athlete_account_payments a
    where a.source_subscription_id = p_subscription_id
      and a.reversed_at is null
  ) into v_has_payment;

  if v_has_payment then
    return json_build_object('ok', false, 'error', 'subscription_has_payments');
  end if;

  v_cutoff := public._studio_today_date();
  v_impact := public._subscription_delete_impact_json(p_subscription_id);
  v_future_impact := v_impact->'future_registrations';

  if (jsonb_array_length(v_future_impact) > 0 or jsonb_array_length(v_impact->'history_sessions') > 0)
     and not coalesce(p_confirmed, false) then
    return (jsonb_build_object('ok', true, 'action', 'preview') || v_impact)::json;
  end if;

  if jsonb_array_length(v_future_impact) > 0 and p_future_registration_action is null then
    return (jsonb_build_object('ok', false, 'error', 'future_registration_action_required') || v_impact)::json;
  end if;

  -- The confirmation must be for what would actually happen now.
  if jsonb_array_length(v_impact->'history_sessions') > 0
     and p_expected_impact_fingerprint is distinct from (v_impact->>'fingerprint') then
    return (jsonb_build_object('ok', false, 'error', 'delete_impact_changed') || v_impact)::json;
  end if;

  if p_future_registration_action is not null and jsonb_array_length(v_future_impact) > 0 then
    if p_expected_future_registration_ids is null or p_expected_future_manual_participant_ids is null then
      return (jsonb_build_object('ok', false, 'error', 'future_registrations_expectation_required') || v_impact)::json;
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(v_future_impact) as x(registration_id uuid, manual_participant_id uuid)
      where (x.registration_id is not null and x.registration_id <> all (p_expected_future_registration_ids))
         or (x.manual_participant_id is not null and x.manual_participant_id <> all (p_expected_future_manual_participant_ids))
    ) then
      return (jsonb_build_object('ok', false, 'error', 'future_registrations_changed') || v_impact)::json;
    end if;
  end if;

  v_source_id := gen_random_uuid();

  -- Reverse every currently-effective charge. Originals are never altered: a new `reversal` row per charge.
  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.subscription_id = p_subscription_id
      and c.charge_type <> 'reversal'
      and not exists (
        select 1 from public.subscription_charges rv
        where rv.charge_type = 'reversal' and rv.reverses = c.id
      )
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id, v_source_id
    );
    v_reversed_count := v_reversed_count + 1;
    v_reversed_total := v_reversed_total + r.amount_ils;
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'delete', v_source_id, v_cutoff, true, v_uid
  ) returning id into v_event_id;

  -- Sessions move to regular price, each one recorded. Sessions with receipt history stay as they are.
  for r in select * from public._subscription_delete_history(p_subscription_id) loop
    if r.has_receipt then
      -- Not repriced. It is recorded for a manager's decision, and stays visible until that decision is made.
      insert into public.subscription_deletion_corrections (
        coverage_id, subscription_id, delete_event_id, registration_id, manual_participant_id, session_id, session_date,
        slot_state, regular_price_ils, amount_paid_ils, receipts
      ) values (
        r.coverage_id, p_subscription_id, v_event_id, r.registration_id, r.manual_participant_id, r.session_id, r.session_date,
        r.slot_state, r.regular_price_ils, r.amount_paid_ils, r.receipts
      );
      v_locked := v_locked + 1;
      continue;
    end if;
    update public.subscription_registration_coverage
    set covered = false, non_coverage_reason = 'subscription_deleted', decided_at = now(), decided_by = 'reconcile'
    where id = r.coverage_id;
    insert into public.subscription_impact_event_registrations (event_id, registration_id, manual_participant_id, previous_covered, new_covered)
    values (v_event_id, r.registration_id, r.manual_participant_id, true, false);
    v_repriced := v_repriced + 1;
  end loop;

  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, v_cutoff, p_future_registration_action
    );
    if v_future_resolved <> jsonb_array_length(v_future_impact) then
      raise exception 'future_registrations_not_resolved'
        using errcode = 'P0001',
              detail = format('expected %s, resolved %s', jsonb_array_length(v_future_impact), v_future_resolved);
    end if;
  end if;

  perform public._insert_activity_event(v_uid, 'subscription_deleted', 'subscription', p_subscription_id::text,
    jsonb_build_object('reversed_charge_count', v_reversed_count, 'reversed_total_ils', v_reversed_total,
      'sessions_repriced', v_repriced, 'sessions_receipt_locked', v_locked, 'new_debt_ils', v_impact->'new_debt_ils',
      'future_registration_action', p_future_registration_action, 'future_registrations_resolved', v_future_resolved));

  return json_build_object(
    'ok', true, 'action', 'tombstoned',
    'reversed_charge_count', v_reversed_count,
    'reversed_total_ils', v_reversed_total,
    'future_registrations_resolved', v_future_resolved,
    'sessions_repriced', v_repriced,
    'sessions_receipt_locked', v_locked
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.manager_subscription_overview_stats(p_start date, p_end date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_active_count int;
  v_charges_total numeric;
  v_payments_total numeric;
  v_lifetime_charges numeric;
  v_lifetime_payments numeric;
  v_today date := public._studio_today_date();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    return json_build_object('ok', false, 'error', 'invalid_range');
  end if;

  -- Point-in-time count, not period-scoped: "how many subscriptions are active right now".
  select count(*) into v_active_count
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) in ('active', 'frozen');

  -- Every charge-ledger row attributed to a billing period starting within the requested
  -- range (the "expected" side) -- unfiltered by charge_type so a reversal/correction posted
  -- in the same window as its original charge nets to the true effect, not the gross amount.
  select coalesce(sum(c.amount_ils), 0) into v_charges_total
  from public.subscription_charges c
  join public.subscription_billing_periods bp on bp.id = c.billing_period_id
  where bp.period_start between p_start and p_end;

  -- Subscription-tagged payments recorded within the requested range (the "collected" side) --
  -- same reversed_at exclusion as every other consumer of this table.
  select coalesce(sum(a.amount_ils), 0) into v_payments_total
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null
    and a.paid_at between p_start and p_end;

  -- Lifetime outstanding across every subscription (not period-scoped): every charge-ledger
  -- row ever posted, net of reversals/corrections by the same unconditional-sum convention
  -- as above. May be negative (overpayment credit) -- reported as-is, matching the existing
  -- outstanding_ils convention.
  select coalesce(sum(c.amount_ils), 0) into v_lifetime_charges
  from public.subscription_charges c;

  select coalesce(sum(a.amount_ils), 0) into v_lifetime_payments
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null;

  return (
    jsonb_build_object(
      'ok', true,
      'active_subscriptions_count', v_active_count,
      'charges_total_ils', v_charges_total,
      'payments_total_ils', v_payments_total,
      'outstanding_ils', v_lifetime_charges - v_lifetime_payments
    ) || (
      with cur as (
        select s.id, s.deleted_at is null as live, v.id as version_id, v.monthly_price_ils,
               public.subscription_version_display_status(v.id, v_today) as status,
               public.subscription_effective_next_billing_date(s.id) as next_charge,
               public.subscription_effective_plan_end_date(v.id) as plan_end,
               coalesce((select sum(c.amount_ils) from public.subscription_charges c where c.subscription_id = s.id), 0)
               - coalesce((select sum(a.amount_ils) from public.athlete_account_payments a
                           where a.source_subscription_id = s.id and a.reversed_at is null), 0) as balance
        from public.subscriptions s
        left join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
      )
      select jsonb_build_object(
        'running_count', count(*) filter (where live and status = 'active'),
        'frozen_count', count(*) filter (where live and status = 'frozen'),
        'scheduled_count', count(*) filter (where live and status = 'scheduled'),
        'open_balance_ils', coalesce(sum(balance) filter (where balance > 0), 0),
        'open_balance_count', count(*) filter (where balance > 0),
        'credit_ils', coalesce(-sum(balance) filter (where balance < 0), 0),
        'charges_next_7d_count', count(*) filter (where live and next_charge between v_today and v_today + 7),
        'charges_next_7d_ils', coalesce(sum(monthly_price_ils) filter (where live and next_charge between v_today and v_today + 7), 0),
        'ending_next_14d_count', count(*) filter (where live and plan_end between v_today and v_today + 14 and status in ('active', 'frozen')),
        'pending_corrections_count', (select count(*) from public.subscription_deletion_corrections k where k.status = 'pending')
      )
      from cur
    )
  )::json;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The manager's decisions on receipt-locked sessions.
-- ---------------------------------------------------------------------------
create or replace function public.manager_list_subscription_corrections(p_pending_only boolean default true)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  return json_build_object('ok', true, 'corrections', coalesce((
    select json_agg(json_build_object(
      'id', k.id, 'subscription_id', k.subscription_id, 'session_id', k.session_id, 'session_date', k.session_date,
      'payee_display_name', coalesce(case when not s.payee_is_manual then p.full_name else mp.full_name end, '(unknown)'),
      'slot_state', k.slot_state, 'regular_price_ils', k.regular_price_ils, 'amount_paid_ils', k.amount_paid_ils,
      'balance_change_if_applied_ils', case when k.slot_state in ('attended', 'penalty') then k.regular_price_ils else 0 end,
      'receipts', k.receipts, 'status', k.status, 'decision_reason', k.decision_reason, 'decided_at', k.decided_at
    ) order by k.session_date, k.created_at)
    from public.subscription_deletion_corrections k
    join public.subscriptions s on s.id = k.subscription_id
    left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
    left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
    where not coalesce(p_pending_only, true) or k.status = 'pending'
  ), '[]'::json));
end;
$$;

-- p_expected_price: the price the manager was shown. If it changed, nothing happens and the screen asks again.
create or replace function public.manager_resolve_subscription_correction(
  p_correction_id uuid, p_decision text, p_reason text, p_expected_price numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  k public.subscription_deletion_corrections%rowtype;
  v_price numeric;
  v_event_id uuid;
  v_source uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_decision not in ('applied_regular_price', 'kept_covered') then
    return json_build_object('ok', false, 'error', 'invalid_decision');
  end if;
  if char_length(v_reason) < 3 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;

  select * into k from public.subscription_deletion_corrections where id = p_correction_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'correction_not_found');
  end if;
  if k.status <> 'pending' then
    if k.status = p_decision then
      return json_build_object('ok', true, 'action', 'already_decided');
    end if;
    return json_build_object('ok', false, 'error', 'already_decided_differently', 'status', k.status);
  end if;

  v_price := coalesce(public.session_billing_price_ils(
    k.session_id,
    (select r.user_id from public.session_registrations r where r.id = k.registration_id),
    (select m.manual_participant_id from public.session_manual_participants m where m.id = k.manual_participant_id)
  ), 0);
  if p_expected_price is distinct from v_price then
    return json_build_object('ok', false, 'error', 'correction_changed', 'regular_price_ils', v_price);
  end if;

  if p_decision = 'applied_regular_price' then
    update public.subscription_registration_coverage
    set covered = false, non_coverage_reason = 'subscription_deleted', decided_at = now(), decided_by = 'reconcile'
    where id = k.coverage_id;

    v_source := md5(k.id::text || '|correction')::uuid;
    insert into public.subscription_impact_events (subscription_id, action_type, action_source_id, effective_date, confirmed, created_by)
    values (k.subscription_id, 'delete', v_source, public._studio_today_date(), true, v_uid)
    returning id into v_event_id;
    insert into public.subscription_impact_event_registrations (event_id, registration_id, manual_participant_id, previous_covered, new_covered)
    values (v_event_id, k.registration_id, k.manual_participant_id, true, false);
  end if;

  update public.subscription_deletion_corrections
  set status = p_decision, decision_reason = v_reason, decided_by = v_uid, decided_at = now(), regular_price_ils = v_price
  where id = k.id;

  perform public._insert_activity_event(v_uid, 'subscription_correction_decided', 'subscription', k.subscription_id::text,
    jsonb_build_object('correction_id', k.id, 'decision', p_decision, 'reason', v_reason, 'session_date', k.session_date,
      'regular_price_ils', v_price, 'amount_paid_ils', k.amount_paid_ils, 'receipts', k.receipts));

  return json_build_object('ok', true, 'action', 'decided', 'status', p_decision);
end;
$$;

revoke all on function public.manager_list_subscription_corrections(boolean) from public, anon;
grant execute on function public.manager_list_subscription_corrections(boolean) to authenticated;
revoke all on function public.manager_resolve_subscription_correction(uuid, text, text, numeric) from public, anon;
grant execute on function public.manager_resolve_subscription_correction(uuid, text, text, numeric) to authenticated;
revoke all on function public.subscription_payment_target(uuid, boolean, date) from public, anon;
grant execute on function public.subscription_payment_target(uuid, boolean, date) to authenticated;
revoke all on function public._subscription_outstanding(uuid) from public, anon, authenticated;
revoke all on function public._subscription_delete_history(uuid) from public, anon, authenticated;
revoke all on function public._subscription_corrections_guard() from public, anon, authenticated;

-- Managers can write account payments directly (the app's general payment path), so the stopped-subscription limit also
-- holds at the table: no direct insert or amount edit can take a stopped subscription past what it owes.
create or replace function public._subscription_payment_cap_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stopped date;
  v_outstanding numeric;
begin
  if new.source_subscription_id is null or new.reversed_at is not null then
    return new;
  end if;
  select sv.stopped_effective_date into v_stopped
  from public.subscription_versions sv
  where sv.subscription_id = new.source_subscription_id and sv.effective_to is null;
  if v_stopped is null or public._studio_today_date() < v_stopped then
    return new;
  end if;
  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(new.source_subscription_id));
  v_outstanding := public._subscription_outstanding(new.source_subscription_id)
                   + case when tg_op = 'UPDATE' then old.amount_ils else 0 end;
  if v_outstanding <= 0 then
    raise exception 'no_outstanding_balance' using errcode = 'P0001';
  end if;
  if new.amount_ils > v_outstanding then
    raise exception 'amount_exceeds_outstanding' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_payment_cap_check on public.athlete_account_payments;
create trigger subscription_payment_cap_check
  before insert or update of amount_ils on public.athlete_account_payments
  for each row execute function public._subscription_payment_cap_check();
revoke all on function public._subscription_payment_cap_check() from public, anon, authenticated;

-- A trigger function has no business being callable by clients.
revoke all on function public._validate_athlete_account_payment() from public, anon, authenticated;
