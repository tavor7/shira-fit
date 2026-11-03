-- Owner decisions 4 and 5 (2026-11-03).
--
-- Deleting a subscription: sessions it covered move to regular price, history included. The manager sees exactly what
-- will change first, and confirms against that exact list. A session with any receipt history is NOT repriced (receipt
-- integrity comes first): it stays as it is and is listed for a separate, approved correction.
-- A recorded payment still blocks deletion outright (owner-approved earlier; stopping is the alternative).
--
-- Stopping is different: it ends the subscription from a date, keeps its past as it was, and prorates. Deleting says the
-- subscription should not have counted at all. There is no third "cancel" operation.
--
-- Unfreezing: a future freeze is cancelled, a running one ends today, a finished one is reversed. All three preview first
-- and go through the normal correction engine. Freeze rows are kept, with who and when.
--
-- No existing row is changed by this migration.

alter table public.subscription_freezes
  add column if not exists cancelled_by uuid references public.profiles(user_id) on delete set null,
  add column if not exists original_freeze_until date,
  add column if not exists ended_early_at timestamptz,
  add column if not exists ended_early_by uuid references public.profiles(user_id) on delete set null;

-- ---------------------------------------------------------------------------
-- Deletion impact
-- ---------------------------------------------------------------------------
create or replace function public._subscription_delete_history(p_subscription_id uuid)
returns table (
  coverage_id uuid, registration_id uuid, manual_participant_id uuid, session_id uuid, session_date date, start_time time,
  slot_state text, regular_price_ils numeric, amount_paid_ils numeric, has_receipt boolean
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
      or (x.id is not null and public._payment_has_any_document('cancellation', x.id))
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

create or replace function public._subscription_delete_impact_json(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
$$;

-- What the manager reads before confirming. Read-only.
create or replace function public.subscription_delete_impact(p_subscription_id uuid)
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
  if not exists (select 1 from public.subscriptions where id = p_subscription_id) then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;
  return (jsonb_build_object('ok', true) || public._subscription_delete_impact_json(p_subscription_id))::json;
end;
$$;

-- ---------------------------------------------------------------------------
-- Delete
-- ---------------------------------------------------------------------------
drop function if exists public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]);

create function public.delete_subscription_with_future_registrations(
  p_subscription_id uuid,
  p_future_registration_action text default null,
  p_confirmed boolean default false,
  p_expected_future_registration_ids uuid[] default null,
  p_expected_future_manual_participant_ids uuid[] default null,
  p_expected_impact_fingerprint text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[], text) from public, anon;
grant execute on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[], text) to authenticated;

-- The old entry point cannot skip the review.
create or replace function public.delete_subscription(p_subscription_id uuid)
returns json
language sql
security definer
set search_path = public
as $$
  select public.delete_subscription_with_future_registrations(p_subscription_id, null, false, null, null, null);
$$;

-- ---------------------------------------------------------------------------
-- Unfreeze
-- ---------------------------------------------------------------------------
create or replace function public._subscription_apply_unfreeze(p_freeze public.subscription_freezes, p_kind text, p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public._studio_today_date();
  v_source_id uuid := md5(p_freeze.id::text || '|unfreeze|' || p_freeze.freeze_until::text)::uuid;
  v_week date := p_freeze.freeze_from - extract(dow from p_freeze.freeze_from)::int;
  v_old_end date;
  r record;
begin
  -- The periods this freeze moved, read before the freeze changes.
  create temporary table if not exists _unfreeze_periods (raw_start date, raw_end date, version_id uuid) on commit drop;
  delete from _unfreeze_periods where true;
  insert into _unfreeze_periods
  select bp.raw_period_start, bp.raw_period_end, bp.version_id
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_freeze.subscription_id and bp.period_end >= p_freeze.freeze_from;

  if p_kind = 'current_end_early' and p_freeze.freeze_from < v_today then
    update public.subscription_freezes
    set original_freeze_until = coalesce(original_freeze_until, freeze_until),
        freeze_until = v_today - 1, ended_early_at = now(), ended_early_by = p_uid
    where id = p_freeze.id;
  else
    update public.subscription_freezes
    set cancelled_at = now(), cancelled_by = p_uid
    where id = p_freeze.id;
  end if;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_freeze.subscription_id and week_start >= v_week
  loop
    perform public.subscription_reconcile_week(p_freeze.subscription_id, r.week_start, r.tier);
  end loop;

  for r in select * from _unfreeze_periods order by raw_start loop
    perform public.subscription_generate_or_correct_billing_period(
      p_freeze.subscription_id, r.version_id, r.raw_start, r.raw_end, v_source_id, 'unfreeze_correction'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_freeze.subscription_id, 'unfreeze', v_source_id, p_freeze.freeze_from, true, p_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;
end;
$$;

create or replace function public.unfreeze_subscription(p_freeze_id uuid, p_confirmed boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := public._studio_today_date();
  v_f public.subscription_freezes%rowtype;
  v_kind text;
  v_sub public.subscriptions%rowtype;
  v_before jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_preview jsonb;
  v_version uuid;
  v_old_next date;
  v_old_end date;
  v_charges_before numeric;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_f from public.subscription_freezes where id = p_freeze_id;
  if not found then
    return json_build_object('ok', false, 'error', 'freeze_not_found');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(v_f.subscription_id));
  select * into v_f from public.subscription_freezes where id = p_freeze_id;

  select * into v_sub from public.subscriptions where id = v_f.subscription_id and deleted_at is null;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  if v_f.cancelled_at is not null then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  v_kind := case when v_f.freeze_from > v_today then 'future_cancel'
                 when v_f.freeze_until >= v_today then 'current_end_early'
                 else 'past_reversal' end;

  select id into v_version from public.subscription_versions where subscription_id = v_f.subscription_id and effective_to is null;
  v_old_next := public.subscription_effective_next_billing_date(v_f.subscription_id);
  v_old_end := public.subscription_effective_plan_end_date(v_version);
  select coalesce(sum(amount_ils), 0) into v_charges_before from public.subscription_charges where subscription_id = v_f.subscription_id;
  select coalesce(jsonb_object_agg(c.id, jsonb_build_object('covered', c.covered, 'reason', c.non_coverage_reason)), '{}'::jsonb)
  into v_before from public.subscription_registration_coverage c where c.subscription_id = v_f.subscription_id;

  -- Run the real correction, read what it did, and roll it back: the preview cannot drift from what confirming does.
  begin
    perform public._subscription_apply_unfreeze(v_f, v_kind, v_uid);

    select coalesce(jsonb_agg(jsonb_build_object(
        'registration_id', c.registration_id, 'manual_participant_id', c.manual_participant_id,
        'session_date', c.session_date, 'tier', c.tier,
        'covered_before', (v_before->c.id::text->>'covered')::boolean, 'covered_after', c.covered,
        'reason_after', c.non_coverage_reason
      ) order by c.session_date), '[]'::jsonb)
    into v_changes
    from public.subscription_registration_coverage c
    where c.subscription_id = v_f.subscription_id
      and ((v_before->c.id::text->>'covered')::boolean is distinct from c.covered
           or (v_before->c.id::text->>'reason') is distinct from c.non_coverage_reason::text);

    v_preview := jsonb_build_object(
      'kind', v_kind,
      'freeze_from', v_f.freeze_from,
      'freeze_until', v_f.freeze_until,
      'session_changes', v_changes,
      'sessions_kept_at_paid_regular_price', (select count(*) from jsonb_array_elements(v_changes) e where e->>'reason_after' = 'paid_at_regular_price'),
      'next_billing_before', v_old_next,
      'next_billing_after', public.subscription_effective_next_billing_date(v_f.subscription_id),
      'plan_end_before', v_old_end,
      'plan_end_after', public.subscription_effective_plan_end_date(v_version),
      'charges_change_ils', (select coalesce(sum(amount_ils), 0) from public.subscription_charges where subscription_id = v_f.subscription_id) - v_charges_before,
      -- Reversing a past freeze can bring the next charge into the past; the daily billing job would then post it.
      'next_charge_becomes_due', coalesce(public.subscription_effective_next_billing_date(v_f.subscription_id) <= v_today, false)
    );

    raise exception using errcode = 'ZZ001', message = 'subscription_unfreeze_preview_rollback';
  exception
    when sqlstate 'ZZ001' then
      null;
  end;

  if not coalesce(p_confirmed, false) then
    return (jsonb_build_object('ok', true, 'action', 'preview') || v_preview)::json;
  end if;

  perform public._subscription_apply_unfreeze(v_f, v_kind, v_uid);

  perform public._insert_activity_event(v_uid, 'subscription_unfrozen', 'subscription', v_f.subscription_id::text,
    v_preview || jsonb_build_object('freeze_id', v_f.id) - 'session_changes');

  return (jsonb_build_object('ok', true, 'action', 'applied') || v_preview)::json;
end;
$$;

revoke all on function public.unfreeze_subscription(uuid, boolean) from public, anon;
grant execute on function public.unfreeze_subscription(uuid, boolean) to authenticated;
revoke all on function public.subscription_delete_impact(uuid) from public, anon;
grant execute on function public.subscription_delete_impact(uuid) to authenticated;

-- Internals stay closed to clients.
revoke all on function public._subscription_slot_state(public.registration_status, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public._subscription_week_slots(date, uuid, boolean) from public, anon, authenticated;
revoke all on function public.subscription_shifted_date(uuid, date) from public, anon, authenticated;
revoke all on function public._subscription_next_charge(uuid) from public, anon, authenticated;
revoke all on function public._subscription_cover_existing_future_registrations(uuid) from public, anon, authenticated;
revoke all on function public._subscription_reconcile_after_coverage_delete() from public, anon, authenticated;
revoke all on function public._subscription_reconcile_after_session_change() from public, anon, authenticated;
revoke all on function public._subscription_delete_history(uuid) from public, anon, authenticated;
revoke all on function public._subscription_delete_impact_json(uuid) from public, anon, authenticated;
revoke all on function public._subscription_apply_unfreeze(public.subscription_freezes, text, uuid) from public, anon, authenticated;
