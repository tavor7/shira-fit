-- Fix: athletes are not carried into cron-generated occurrences of a roster-copying series.
--
-- Root cause (reproduced): _copy_session_roster() adds each athlete with
-- `perform public.coach_add_athlete(...)` and ignores the result. coach_add_athlete() authorizes from
-- auth.uid() and returns {"ok":false,"error":"not_authenticated"} when it is null. When an occurrence
-- is generated through the manager's client (maintain_session_series_horizon) auth.uid() is the
-- manager and the copy works; when pg_cron generates it (cron_maintain_session_series_horizon ->
-- _maintain_session_series_horizon_core) auth.uid() is null, every athlete add is rejected and the
-- occurrence is created without them, even though the series' creator chose roster_policy =
-- 'copy_on_generate'. Manual participants already worked (their helper does not use auth.uid()).
-- (The earlier lookup fix, 20261005170000, is what lets the cron path reach this copy step at all.)
--
-- Fix:
--   1. _coach_add_athlete_core(...) holds the single implementation of the athlete add: session row
--      lock, session existence, eligibility (approved athlete/coach, not the session's coach),
--      disabled-on-date, capacity rule, subscription reservation, registration upsert, registration
--      history, waitlist cleanup and subscription coverage. Its body is the former body of
--      coach_add_athlete, unchanged, except that the "caller is a manager or the session's own coach"
--      check applies only when p_actor is not null. p_actor null means "trusted server-side caller
--      with no interactive identity" and skips ONLY that actor check; every business rule above still
--      runs. The function is internal: EXECUTE is revoked from PUBLIC, anon, authenticated and
--      service_role; it is SECURITY DEFINER, owner postgres, search_path = public.
--   2. coach_add_athlete keeps its exact public contract and authorization order: not_authenticated,
--      forbidden (not coach/manager), then the core with p_actor = auth.uid() (session_not_found,
--      owner-coach/manager check, ...); errors are still returned as {"ok":false,"error":<message>}.
--   3. _copy_session_roster uses the core only when auth.uid() is null. When there is an
--      authenticated caller it still calls coach_add_athlete exactly as before, so the interactive
--      manager/client behavior (including a coach creating a series for another coach, whose copy is
--      still rejected) is unchanged. Both paths pass the same parameters: over-capacity allowed (the
--      existing copy semantics) and no acceptance of extra subscription charges, so athletes whose
--      subscription does not cover the session are skipped on both paths, as before. The result of
--      each add is still not inspected (partial-failure handling is deliberately unchanged).
--
-- Why a client cannot use this as a privilege bypass: _copy_session_roster and every function that
-- reaches it (the series generators, cron wrapper) had client EXECUTE revoked by
-- 20261005160000; the only client-callable functions that reach it, staff_create_session_series and
-- maintain_session_series_horizon, return not_authenticated / forbidden before doing anything when
-- auth.uid() is null or the caller is not a coach/manager, so they always take the interactive
-- branch. No function sets request.jwt.* or impersonates a user. The new core is not executable by any
-- client role and its caller can never choose an actor on behalf of a client.
--
-- Forward-looking only: no existing session, registration or roster is touched.

create or replace function public._coach_add_athlete_core(
  p_session_id uuid,
  p_user_id uuid,
  p_allow_over_capacity boolean,
  p_accept_extra_subscription_charge boolean,
  p_actor uuid
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sess public.training_sessions%rowtype;
  v_count int;
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id for update;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if p_actor is not null then
    if public.is_manager(p_actor) then
      null;
    elsif v_sess.coach_id = p_actor and exists (select 1 from public.profiles p where p.user_id = p_actor and p.role = 'coach') then
      null;
    else
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  if v_sess.coach_id = p_user_id then
    return json_build_object('ok', false, 'error', 'is_session_coach');
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = p_user_id and approval_status = 'approved' and role in ('athlete', 'coach')
  ) then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;

  if public.athlete_disabled_on_date(p_user_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  v_decision := public.subscription_reserve_or_reject(
    p_user_id, false, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  insert into public.session_registrations (session_id, user_id, status)
  values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update
    set status = 'active', registered_at = now()
  returning id into v_reg_id;

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'registered');

  delete from public.waitlist_requests where session_id = p_session_id and user_id = p_user_id;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
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
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
end;
$function$;

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
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

create or replace function public._copy_session_roster(p_from_session uuid, p_to_session uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  m record;
  -- No authenticated caller means a server-side run (pg_cron horizon maintenance). Authorization for
  -- the copy was given when the creator stored the series' roster_policy.
  v_trusted boolean := auth.uid() is null;
begin
  if p_from_session is null or p_to_session is null or p_from_session = p_to_session then
    return;
  end if;

  for r in
    select user_id
    from public.session_registrations
    where session_id = p_from_session and status = 'active'
  loop
    begin
      if v_trusted then
        perform public._coach_add_athlete_core(p_to_session, r.user_id, true, false, null);
      else
        perform public.coach_add_athlete(p_to_session, r.user_id, true);
      end if;
    exception when others then
      null;
    end;
  end loop;

  for m in
    select manual_participant_id
    from public.session_manual_participants
    where session_id = p_from_session
  loop
    begin
      perform public._series_add_manual_participant_checked(p_to_session, m.manual_participant_id);
    exception when others then
      null;
    end;
  end loop;
end;
$function$;

-- The core is internal. Default privileges grant EXECUTE to PUBLIC/anon/authenticated/service_role on
-- new functions, so revoke every client-facing role explicitly.
revoke execute on function public._coach_add_athlete_core(uuid, uuid, boolean, boolean, uuid)
  from public, anon, authenticated, service_role;

-- Self-check: abort if the internal core is reachable by any client role, or the public wrapper lost access.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, 'public._coach_add_athlete_core(uuid, uuid, boolean, boolean, uuid)'::regprocedure, 'EXECUTE') then
      raise exception '_coach_add_athlete_core must not be executable by %', v_role;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.coach_add_athlete(uuid, uuid, boolean, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'coach_add_athlete must remain executable by authenticated';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public._copy_session_roster(uuid, uuid)'::regprocedure, 'EXECUTE') then
      raise exception '_copy_session_roster must not be executable by %', v_role;
    end if;
  end loop;
end $$;
