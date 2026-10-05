-- Security: revoke client EXECUTE on the internal recurring-series functions.
--
-- These six functions are server-side internals. They are SECURITY DEFINER (owner postgres,
-- search_path = public) and perform NO caller authorization of their own -- the authorization lives
-- in the public entry points that call them (maintain_session_series_horizon,
-- staff_create_session_series) and in the pg_cron job. Supabase's default privileges nevertheless left
-- EXECUTE granted to PUBLIC / anon / authenticated, so any client could call them directly through the
-- REST API (/rpc/...), including a completely unauthenticated (anon) caller:
--   _series_add_manual_participant_checked(session, manual_participant)
--       inserts a manual participant into ANY session with no capacity check;
--   _copy_session_roster(from_session, to_session)
--       copies manual participants from any session into any other session;
--   _generate_series_occurrence_claim / _generate_series_occurrences /
--   _maintain_session_series_horizon_core
--       create series occurrences (sessions) on demand;
--   cron_maintain_session_series_horizon
--       runs the whole daily horizon job (anon holds a direct grant).
-- Verified before this migration with real anon/authenticated roles: all of these executed.
--
-- Callers (audited): only SECURITY DEFINER functions owned by postgres -- maintain_session_series_horizon
-- (auth-checked wrapper), staff_create_session_series (auth-checked) and the internal chain among these
-- six -- plus the pg_cron job `maintain-session-series-horizon`, which runs as postgres. A definer's
-- inner calls are checked against the function owner, and the owner keeps EXECUTE, so none of them is
-- affected. Nothing in the mobile app or the edge functions calls these directly. service_role keeps
-- its existing grant.
--
-- Pure privilege change: no function body, policy, table or data is touched. The public entry points
-- keep their existing grants and their own authorization checks.

revoke execute on function public._series_add_manual_participant_checked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._copy_session_roster(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._generate_series_occurrence_claim(uuid, date) from public, anon, authenticated;
revoke execute on function public._generate_series_occurrences(uuid, date, date) from public, anon, authenticated;
revoke execute on function public._maintain_session_series_horizon_core() from public, anon, authenticated;
revoke execute on function public.cron_maintain_session_series_horizon() from public, anon, authenticated;

-- Self-check: abort if any of them is still client-executable, or a legitimate entry point lost access.
do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_fn in array array[
    'public._series_add_manual_participant_checked(uuid, uuid)',
    'public._copy_session_roster(uuid, uuid)',
    'public._generate_series_occurrence_claim(uuid, date)',
    'public._generate_series_occurrences(uuid, date, date)',
    'public._maintain_session_series_horizon_core()',
    'public.cron_maintain_session_series_horizon()'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') then
        raise exception '% is still executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;

  foreach v_fn in array array[
    'public.maintain_session_series_horizon()',
    'public.coach_add_athlete(uuid, uuid, boolean, boolean)',
    'public.staff_create_session_series(date, time, uuid, integer, integer, boolean, boolean, boolean, numeric, text, integer, boolean, uuid[], uuid[])'
  ] loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'legitimate entry point % lost EXECUTE for authenticated', v_fn;
    end if;
  end loop;
end $$;
