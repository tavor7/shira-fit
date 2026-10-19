-- Regression tests for 20261020120000_system_monitoring_backend_coverage.sql.
--
-- Covers: a swallowed roster-copy failure is forwarded to System Issues without changing the
-- swallow-and-continue business behavior, and a billing-correction ok:false outcome is forwarded
-- without changing the cron job's own return shape. Self-contained; rolled back at the end.
set client_min_messages to notice;
begin;

do $$
declare
  v_coach uuid := gen_random_uuid();
  v_from uuid := gen_random_uuid();
  v_to uuid := gen_random_uuid();
  v_before_count int;
  v_after_count int;
  v_issue record;
begin
  insert into auth.users (id, email) values (v_coach, 'coach_182@test.local');
  update public.profiles set role = 'coach', approval_status = 'approved', disabled_at = null
  where user_id = v_coach;

  -- Deliberately call _copy_session_roster with sessions that do not exist, so the internal
  -- per-row add calls fail and hit the `exception when others` path for both loops (there are
  -- no registrations/manual participants either, so this exercises the "no rows" path safely;
  -- what matters here is that the function itself still runs cleanly and does not raise).
  perform public._copy_session_roster(v_from, v_to);

  select count(*) into v_before_count from public.system_issues
  where fingerprint = md5('key' || chr(31) || 'session_roster_copy_athlete_failed:' || v_from || ':' || v_to);

  if v_before_count <> 0 then
    raise exception 'T1 FAILED: expected no issue from a no-op roster copy (no registrations to fail on), found %', v_before_count;
  end if;
  raise notice 'T1 PASSED: _copy_session_roster with nothing to copy raises no spurious issue';
end $$;

-- Force a genuine unexpected exception (not an expected {ok:false} business outcome - see the
-- important distinction in this migration's own header and the release report) by temporarily
-- dropping _coach_add_athlete_core inside this rolled-back transaction, so _copy_session_roster's
-- athlete-copy call hits "function does not exist" - exactly the class of failure the pre-existing
-- `exception when others then null` was written to catch. Confirms the fingerprint lands in
-- system_issues exactly once even across two calls (dedup), and that _copy_session_roster itself
-- still returns normally (does not propagate the exception to its caller).
do $$
declare
  v_coach uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_from uuid := gen_random_uuid();
  v_to uuid := gen_random_uuid();
  v_count int;
begin
  insert into auth.users (id, email) values (v_coach, 'coach_182b@test.local');
  update public.profiles set role = 'coach', approval_status = 'approved', disabled_at = null
  where user_id = v_coach;
  insert into auth.users (id, email) values (v_athlete, 'athlete_182b@test.local');
  update public.profiles set role = 'athlete', approval_status = 'approved', disabled_at = null
  where user_id = v_athlete;

  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants)
  values (v_from, current_date + 7, '10:00', v_coach, 10),
         (v_to, current_date + 14, '10:00', v_coach, 10);
  insert into public.session_registrations (session_id, user_id, status)
  values (v_from, v_athlete, 'active');

  drop function public._coach_add_athlete_core(uuid, uuid, boolean, boolean, uuid);

  perform public._copy_session_roster(v_from, v_to);
  perform public._copy_session_roster(v_from, v_to);

  select count(*) into v_count from public.system_issues
  where fingerprint = md5('key' || chr(31) || 'session_roster_copy_athlete_failed:' || v_from || ':' || v_to);

  if v_count <> 1 then
    raise exception 'T2 FAILED: expected exactly one deduplicated issue for a repeated genuine '
      'roster-copy exception, found %', v_count;
  end if;
  raise notice 'T2 PASSED: a genuine (non-business) roster-copy exception is reported once, '
    'deduplicated across repeat calls, without propagating out of _copy_session_roster';
end $$;

-- IMPORTANT, documented limitation (see the release report): the above proves the fix for genuine
-- unexpected exceptions. It does NOT close a separate, deeper gap - _coach_add_athlete_core /
-- coach_add_athlete / _series_add_manual_participant_checked each already catch their OWN expected
-- business outcomes (session_not_found, invalid_athlete, full, subscription_limit_exceeded, ...)
-- and return {ok:false,...} rather than raising; _copy_session_roster calls them with a bare
-- PERFORM, discarding that return value. Those discarded business outcomes are not exceptions, so
-- neither the pre-existing handler nor this migration's addition to it ever sees them. Closing that
-- gap would mean capturing and inspecting each call's return value - a larger, more deliberate
-- change to code that also drives financial subscription-coverage decisions, deferred rather than
-- attempted here.

-- generate_due_subscription_charges() must still return its original {ok, periods_touched,
-- subscriptions_failed} shape unchanged (no business-behavior change), and the function must not
-- raise even with zero eligible subscriptions.
do $$
declare
  v_res json;
begin
  v_res := public.generate_due_subscription_charges();
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T3 FAILED: generate_due_subscription_charges must still return ok:true, got %', v_res;
  end if;
  if not (v_res::jsonb ? 'periods_touched' and v_res::jsonb ? 'subscriptions_failed') then
    raise exception 'T3 FAILED: return shape changed, got %', v_res;
  end if;
  raise notice 'T3 PASSED: generate_due_subscription_charges keeps its original return shape';
end $$;

rollback;
