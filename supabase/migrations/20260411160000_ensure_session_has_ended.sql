-- Helper used by coach_add_athlete, register_for_session, request_waitlist,
-- add_manual_participant_to_session, etc. If 20260408120000 was skipped or the
-- function was dropped, RPCs fail with: function _session_has_ended(training_sessions) does not exist.

create or replace function public._session_has_ended(v_sess public.training_sessions)
returns boolean
language plpgsql
stable
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  v_start := (v_sess.session_date + v_sess.start_time)::timestamptz;
  v_end := v_start + make_interval(mins => coalesce(v_sess.duration_minutes, 60));
  return now() >= v_end;
end;
$$;
