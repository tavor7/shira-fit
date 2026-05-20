-- Athletes cannot self-cancel after the session has started (studio local time).

create or replace function public._session_has_started(v_sess public.training_sessions)
returns boolean
language plpgsql
stable
as $$
declare
  v_start timestamptz;
begin
  v_start :=
    ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp
      at time zone 'Asia/Jerusalem');
  return now() >= v_start;
end;
$$;

comment on function public._session_has_started(public.training_sessions) is
  'True when studio-local session start time has passed.';

create or replace function public.cancel_registration(p_session_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess training_sessions%rowtype;
  v_start timestamptz;
  v_late boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_reason is null or length(trim(p_reason)) < 1 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_started(v_sess) then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;
  if not exists (
    select 1 from session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;

  v_start :=
    ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp
      at time zone 'Asia/Jerusalem');
  v_late := (now() >= v_start - interval '12 hours') and (now() < v_start);

  update session_registrations
  set status = 'cancelled'
  where session_id = p_session_id and user_id = v_uid and status = 'active';
  if not found then return json_build_object('ok', false, 'error', 'update_failed'); end if;

  insert into cancellations (session_id, user_id, reason, charged_full_price, penalty_collected_ils)
  values (p_session_id, v_uid, p_reason, false, 0);

  insert into registration_history (session_id, user_id, event_type, meta)
  values (
    p_session_id,
    v_uid,
    'cancelled',
    json_build_object('late_cancellation', v_late, 'charged_full_price', false)
  );

  return json_build_object(
    'ok', true,
    'late_cancellation', v_late,
    'charged_full_price', false
  );
end;
$$;

grant execute on function public.cancel_registration(uuid, text) to authenticated;
