-- Scenario B of the subscription start-date-editing investigation: a subscription that has future
-- registrations (so subscription_registration_coverage rows already exist) but zero completed
-- activity and zero financial/freeze history -- correct_subscription_start_date() (20261031162229)
-- deliberately refuses this case (has_history), since it only covers the zero-coverage-rows-at-all
-- scenario. This migration adds a SEPARATE, new-named RPC for the future-registrations case,
-- mirroring the stop_subscription_with_future_registrations precedent (20261026180000): a brand
-- new entry point, the existing one left byte-for-byte untouched, so there is no DROP FUNCTION, no
-- ambiguous overload, and nothing already calling correct_subscription_start_date is affected.
--
-- Eligibility for this RPC (anything else returns has_history -- that is scenario C, not handled
-- here, by design):
--   - exactly one subscription_versions row, never edited (version_no = 1, superseded_by null)
--   - zero rows in subscription_freezes, subscription_billing_periods, subscription_charges,
--     athlete_account_payments (source_subscription_id) -- no financial activity of any kind
--   - EVERY existing subscription_registration_coverage row is for a session that has not yet
--     ended (public._session_has_ended, the codebase's own canonical "has this session's
--     studio-timezone wall-clock window passed" check -- same predicate
--     stop_subscription_with_future_registrations already relies on) AND whose underlying
--     registration/manual participation shows no completed activity (attended is still null, the
--     registration is still 'active', and no charged cancellation exists for it)
--
-- Mechanism: once eligible, the one version's plan_start_date/effective_from/anchor_day are
-- corrected exactly as correct_subscription_start_date() does (anchor_day only recomputed when it
-- was never customized away from the default), then EVERY existing (tier, week_start) pair for
-- this subscription is re-run through subscription_reconcile_week() -- the same authoritative,
-- already-idempotent recompute edit_subscription_version() itself calls after a price/allowance
-- edit (see 20261026080552). Nothing is deleted and re-inserted: reconcile_week's own
-- ON CONFLICT (registration_id) DO UPDATE already recomputes each row's covered/non_coverage_reason
-- in place from the live version/allowance/freeze state, so reusing it here is not new coverage
-- logic, just the existing engine re-run under the corrected start date.
--
-- Preview: uses the exact sentinel-exception rollback technique subscription_compute_impact()
-- already established for freeze/stop/edit previews (raise a sentinel errcode inside a BEGIN block,
-- catch it, which undoes every DML since the BEGIN -- a real, authoritative dry run, not a
-- duplicated estimate). p_confirmed = false (the default) always rolls back and returns the diff
-- (which rows would change and how); p_confirmed = true re-validates eligibility fresh (protecting
-- against anything that changed since an earlier preview -- e.g. a session that completed in the
-- meantime now fails the "no completed activity" check and the whole call is refused with
-- has_history, forcing a new preview) and, if still eligible, actually commits.

create or replace function public.correct_subscription_start_date_with_future_registrations(
  p_subscription_id uuid,
  p_new_start_date date,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_has_financial_history boolean;
  v_has_completed_or_past_activity boolean;
  v_old_anchor_matched_default boolean;
  v_new_anchor smallint;
  v_count int := 0;
  v_items jsonb := '[]'::jsonb;
  r record;
  v_after public.subscription_registration_coverage%rowtype;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if v_current.plan_end_date is not null and v_current.plan_end_date < p_new_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;

  if v_current.version_no <> 1 or v_current.superseded_by is not null then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'edited_version');
  end if;

  select exists (
    select 1 from public.subscription_freezes where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_billing_periods where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_charges where subscription_id = p_subscription_id
    union all
    select 1 from public.athlete_account_payments where source_subscription_id = p_subscription_id
  ) into v_has_financial_history;

  if v_has_financial_history then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'financial_activity');
  end if;

  select exists (
    select 1
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    left join public.session_manual_participants m on m.id = cov.manual_participant_id
    join public.training_sessions ts on ts.id = coalesce(reg.session_id, m.session_id)
    where cov.subscription_id = p_subscription_id
      and (
        public._session_has_ended(ts)
        or (reg.id is not null and (reg.attended is not null or reg.status <> 'active'))
        or (m.id is not null and m.attended is not null)
      )
  ) into v_has_completed_or_past_activity;

  if v_has_completed_or_past_activity then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'completed_or_past_activity');
  end if;

  v_old_anchor_matched_default := v_current.anchor_day = extract(day from v_current.plan_start_date)::smallint;
  v_new_anchor := case when v_old_anchor_matched_default
    then extract(day from p_new_start_date)::smallint
    else v_current.anchor_day
  end;

  create temporary table if not exists _start_date_correction_before (
    coverage_id uuid primary key,
    covered boolean not null,
    non_coverage_reason public.subscription_non_coverage_reason
  ) on commit drop;
  delete from _start_date_correction_before where coverage_id is not null;

  insert into _start_date_correction_before (coverage_id, covered, non_coverage_reason)
  select id, covered, non_coverage_reason
  from public.subscription_registration_coverage
  where subscription_id = p_subscription_id;

  begin
    update public.subscription_versions
    set plan_start_date = p_new_start_date,
        effective_from = p_new_start_date,
        anchor_day = v_new_anchor
    where id = v_current.id;

    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    for v_after in
      select cov.*
      from public.subscription_registration_coverage cov
      join _start_date_correction_before b on b.coverage_id = cov.id
      where cov.subscription_id = p_subscription_id
        and (cov.covered is distinct from b.covered or cov.non_coverage_reason is distinct from b.non_coverage_reason)
    loop
      v_count := v_count + 1;
      v_items := v_items || jsonb_build_object(
        'registration_id', v_after.registration_id,
        'manual_participant_id', v_after.manual_participant_id,
        'session_date', v_after.session_date,
        'week_start', v_after.week_start,
        'tier', v_after.tier,
        'new_covered', v_after.covered,
        'new_non_coverage_reason', v_after.non_coverage_reason
      );
    end loop;

    if not p_confirmed then
      raise exception using errcode = 'ZZ002', message = 'start_date_correction_preview_rollback';
    end if;
  exception
    when sqlstate 'ZZ002' then
      return json_build_object(
        'ok', true, 'action', 'preview', 'count', v_count, 'items', v_items, 'new_anchor_day', v_new_anchor
      );
  end;

  return json_build_object(
    'ok', true, 'action', 'applied', 'count', v_count, 'items', v_items,
    'plan_start_date', p_new_start_date, 'anchor_day', v_new_anchor
  );
end;
$$;

comment on function public.correct_subscription_start_date_with_future_registrations(uuid, date, boolean) is
  'Manager-only. Scenario B of start-date correction: safe for a subscription with future '
  'registrations but zero completed activity and zero billing/charge/payment/freeze history -- '
  're-runs subscription_reconcile_week for every affected week under the corrected date. '
  'p_confirmed=false (default) always rolls back and returns a dry-run diff (action=preview); '
  'p_confirmed=true re-validates eligibility fresh and, if still eligible, applies it '
  '(action=applied). Returns has_history for anything with real financial/completed-activity '
  'history -- that is scenario C, deliberately not handled by this function.';

revoke execute on function public.correct_subscription_start_date_with_future_registrations(uuid, date, boolean) from public, anon;
grant execute on function public.correct_subscription_start_date_with_future_registrations(uuid, date, boolean) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.correct_subscription_start_date_with_future_registrations(uuid, date, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unexpected anon privilege on correct_subscription_start_date_with_future_registrations';
  end if;
end $$;
