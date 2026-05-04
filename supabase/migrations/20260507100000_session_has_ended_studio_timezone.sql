-- Session end checks must match app semantics: date + time are studio wall-clock (Asia/Jerusalem).
-- Previous (date + time)::timestamptz used the DB session timezone (typically UTC), so e.g. 08:00 local
-- could be treated as 08:00 UTC and registrations stayed open for hours after the real end.

create or replace function public._session_has_ended(v_sess public.training_sessions)
returns boolean
language plpgsql
stable
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  v_start :=
    ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp
      at time zone 'Asia/Jerusalem');
  v_end := v_start + make_interval(mins => coalesce(v_sess.duration_minutes, 60));
  return now() >= v_end;
end;
$$;
