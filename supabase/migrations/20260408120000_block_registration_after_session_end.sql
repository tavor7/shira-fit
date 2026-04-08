-- Block registrations after session end (athlete self-register + staff-added).
-- Ensures no one can be added to a session that has already ended.

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

-- Athlete self-register
create or replace function public.register_for_session(p_session_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;
  if not v_sess.is_open_for_registration then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  if exists (select 1 from session_registrations where session_id = p_session_id and user_id = v_uid and status = 'active') then
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;
  insert into session_registrations (session_id, user_id, status) values (p_session_id, v_uid, 'active');
  insert into registration_history (session_id, user_id, event_type) values (p_session_id, v_uid, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = v_uid;
  return json_build_object('ok', true);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'already_registered');
end;
$$;

-- Athlete waitlist request
create or replace function public.request_waitlist(p_session_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
declare v_profile profiles%rowtype;
declare v_count int;
declare v_sess training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if v_profile.approval_status <> 'approved' or v_profile.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count < v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'not_full');
  end if;
  insert into waitlist_requests (session_id, user_id) values (p_session_id, v_uid)
  on conflict (session_id, user_id) do nothing;
  return json_build_object('ok', true);
end;
$$;

-- Staff: add athlete to session (coach / manager)
create or replace function public.coach_add_athlete(p_session_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id and approval_status = 'approved' and role = 'athlete') then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  insert into session_registrations (session_id, user_id, status) values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update set status = 'active', registered_at = now();
  insert into registration_history (session_id, user_id, event_type) values (p_session_id, p_user_id, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = p_user_id;
  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

-- Staff: add manual participant to session (coach own session or manager)
create or replace function public.add_manual_participant_to_session(
  p_session_id uuid,
  p_manual_participant_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_count int;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  insert into public.session_manual_participants (session_id, manual_participant_id)
  values (p_session_id, p_manual_participant_id)
  on conflict (session_id, manual_participant_id) do nothing;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'already_in_session');
  end if;

  return json_build_object('ok', true);
end;
$$;

-- Keep execute grants explicit (safe if already granted).
grant execute on function public.register_for_session(uuid) to authenticated;
grant execute on function public.request_waitlist(uuid) to authenticated;
grant execute on function public.coach_add_athlete(uuid, uuid) to authenticated;
grant execute on function public.add_manual_participant_to_session(uuid, uuid) to authenticated;

