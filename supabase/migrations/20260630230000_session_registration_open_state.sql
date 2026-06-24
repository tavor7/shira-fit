-- Per-session registration opening state for athletes (uses manager-configured weekly schedule).

create or replace function public.get_session_registration_open_state(p_session_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_sess record;
  v_open_weekday int;
  v_open_time time;
  v_session_week_start date;
  v_opening_week_start date;
  v_scheduled_open timestamptz;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_session_id');
  end if;

  select s.session_date, s.is_open_for_registration
  into v_sess
  from public.training_sessions s
  where s.id = p_session_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if coalesce(v_sess.is_open_for_registration, false) then
    return jsonb_build_object('ok', true, 'status', 'open');
  end if;

  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := least(6, greatest(0, coalesce(v_open_weekday, 4)));
  v_open_time := coalesce(v_open_time, time '08:00');

  v_session_week_start := public._week_start_sunday(v_sess.session_date);
  v_opening_week_start := v_session_week_start - 7;
  v_scheduled_open := public._registration_open_at(v_opening_week_start, v_open_weekday, v_open_time);

  if now() < v_scheduled_open then
    return jsonb_build_object(
      'ok', true,
      'status', 'scheduled',
      'scheduled_open_at', to_char(v_scheduled_open, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'timezone', 'Asia/Jerusalem'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'pending',
    'timezone', 'Asia/Jerusalem'
  );
end;
$$;

comment on function public.get_session_registration_open_state(uuid) is
  'Returns whether registration is open, scheduled (future weekly opening), or pending (past opening time but still closed).';

grant execute on function public.get_session_registration_open_state(uuid) to authenticated;
