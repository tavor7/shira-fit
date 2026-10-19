-- System Issues monitoring completion, pre-release verification pass, item 1: backend coverage
-- for the remaining discarded outcomes in _coach_add_athlete_core / coach_add_athlete /
-- _series_add_manual_participant_checked (flagged as a known residual gap in
-- 20261020120000's header).
--
-- Per-function classification of every outcome (business rejection / technical failure /
-- uncertain), decided by reading the real, current bodies below (not reconstructed from memory -
-- both functions were re-read in full from their canonical migration files, 20261005180000 and
-- 20260924120000, immediately before writing this one):
--
-- _coach_add_athlete_core (NOT redefined by this migration - see why below):
--   session_not_found, forbidden, is_session_coach, invalid_athlete, account_disabled, full,
--   subscription_limit_exceeded -> all BUSINESS REJECTIONS: each is an explicit, anticipated
--   `return json_build_object('ok', false, 'error', ...)` for a condition the function checks on
--   purpose. None of these are reported, per instruction.
--   This function has NO exception handler of its own - any genuine exception inside it (a
--   constraint violation it did not anticipate, a deadlock, an unexpected error surfacing from
--   subscription_reserve_or_reject) propagates to whichever caller invoked it. Both real callers
--   already have their own handler: the trusted path (_copy_session_roster, v_trusted=true) was
--   already covered by 20261020120000; the interactive path (through coach_add_athlete below) is
--   covered by this migration. _coach_add_athlete_core itself is therefore left untouched -
--   redefining it would only add exposure to a transcription mistake for zero new coverage.
--
-- coach_add_athlete (redefined below, body otherwise byte-for-byte unchanged):
--   not_authenticated, forbidden -> BUSINESS REJECTIONS (explicit, anticipated), not reported.
--   Delegating to _coach_add_athlete_core and returning its result as-is -> not reported (that
--   function's own outcomes are classified above; this wrapper does not re-interpret them).
--   `exception when others then return json_build_object('ok', false, 'error', sqlerrm)` -> the
--   ONLY place in this function that can fire is a genuine, unanticipated exception (every
--   anticipated outcome above already returns without raising) -> TECHNICAL FAILURE. Reported.
--
-- _series_add_manual_participant_checked (redefined below, body otherwise byte-for-byte
-- unchanged):
--   session not found (`if not found then return; end if;`) -> BUSINESS REJECTION (the session
--   was deleted/changed since the series-copy loop read its id list - an expected stale-reference
--   case, same pattern already classified for sibling functions in rpcOutcomes/registry.ts), not
--   reported.
--   `v_decision.outcome not in ('not_subscribed', 'covered')` (i.e. a non-covered subscription
--   outcome) -> BUSINESS REJECTION, already handled explicitly (records an activity-log event,
--   `series_manual_participant_subscription_skipped`); not reported.
--   `exception when others then null` -> every expected outcome above already returns/continues
--   without raising, so this can only fire for a genuine unanticipated exception (a constraint
--   violation on insert, subscription_reserve_or_reject raising unexpectedly, etc.) ->
--   TECHNICAL FAILURE. Reported.
--
-- Preserved exactly, verified by direct comparison against the two source migrations before
-- writing this file: input validation, authorization checks, all business-rule branches, every
-- return value/shape, subscription_reserve_or_reject's call signature and its result handling
-- (financial coverage decisions are completely untouched), and the on-conflict upsert logic.
-- Transaction-safety: the report call sits inside the function's own pre-existing exception
-- handler, after any failed work has already been rolled back to that handler's implicit
-- savepoint; nothing in either function runs afterward that could abort the whole transaction
-- because of this addition - same accepted "durable only if the outer transaction commits"
-- limitation documented in 20261006120000 and 20261020120000, not re-litigated here.

create or replace function public.coach_add_athlete(
  p_session_id uuid,
  p_user_id uuid,
  p_allow_over_capacity boolean default false,
  p_accept_extra_subscription_charge boolean default false
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  return public._coach_add_athlete_core(
    p_session_id, p_user_id, p_allow_over_capacity, p_accept_extra_subscription_charge, v_uid
  );
exception when others then
  perform public._report_system_error(
    p_source := 'trusted',
    p_subsystem := 'session_series',
    p_operation := 'coach_add_athlete',
    p_error_class := 'unexpected_exception',
    p_error_code := sqlstate,
    p_message := left(sqlerrm, 300),
    p_severity := 'error',
    p_entities := jsonb_build_object('session_id', p_session_id),
    p_fingerprint_key := 'coach_add_athlete_exception:' || sqlstate);
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

create or replace function public._series_add_manual_participant_checked(
  p_session_id uuid,
  p_manual_participant_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess public.training_sessions%rowtype;
  v_decision public.subscription_reserve_decision;
  v_reg_id uuid;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return;
  end if;

  -- accept_extra is always false here: there is no human present at series-copy time to give
  -- consent, so a non-covered outcome must never silently become a paid registration.
  v_decision := public.subscription_reserve_or_reject(p_manual_participant_id, true, p_session_id, false);

  if v_decision.outcome in ('not_subscribed', 'covered') then
    insert into public.session_manual_participants (session_id, manual_participant_id)
    values (p_session_id, p_manual_participant_id)
    on conflict (session_id, manual_participant_id) do nothing
    returning id into v_reg_id;

    if v_reg_id is not null and v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, null, v_reg_id,
        v_sess.session_date, v_decision.week_start, v_decision.tier,
        true, null, now(), 'registration'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = true,
        non_coverage_reason = null,
        decided_at = now(),
        decided_by = 'registration';
    end if;
  else
    perform public._insert_activity_event(
      auth.uid(),
      'series_manual_participant_subscription_skipped',
      'session_manual_participant',
      p_manual_participant_id::text,
      jsonb_build_object(
        'session_id', p_session_id,
        'manual_participant_id', p_manual_participant_id,
        'reason', v_decision.non_coverage_reason
      )
    );
  end if;
exception when others then
  perform public._report_system_error(
    p_source := 'trusted',
    p_subsystem := 'session_series',
    p_operation := 'series_add_manual_participant_checked',
    p_error_class := 'unexpected_exception',
    p_error_code := sqlstate,
    p_message := left(sqlerrm, 300),
    p_severity := 'error',
    p_entities := jsonb_build_object('session_id', p_session_id),
    p_fingerprint_key := 'series_add_manual_participant_exception:' || sqlstate);
end;
$$;
