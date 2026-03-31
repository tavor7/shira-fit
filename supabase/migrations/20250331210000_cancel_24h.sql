-- Late cancellation threshold: 24 hours (was 12 hours).

create or replace function public.cancel_registration(p_session_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess training_sessions%rowtype;
  v_start timestamptz;
  v_charged boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_reason is null or length(trim(p_reason)) < 1 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not exists (
    select 1 from session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;

  v_start := (v_sess.session_date + v_sess.start_time)::timestamptz;
  v_charged := (now() > v_start - interval '24 hours');

  update session_registrations
  set status = 'cancelled'
  where session_id = p_session_id and user_id = v_uid and status = 'active';
  if not found then return json_build_object('ok', false, 'error', 'update_failed'); end if;

  insert into cancellations (session_id, user_id, reason, charged_full_price)
  values (p_session_id, v_uid, p_reason, v_charged);

  insert into registration_history (session_id, user_id, event_type, meta)
  values (p_session_id, v_uid, 'cancelled', json_build_object('charged_full_price', v_charged));

  return json_build_object('ok', true, 'charged_full_price', v_charged);
end;
$$;

grant execute on function public.cancel_registration(uuid, text) to authenticated;

