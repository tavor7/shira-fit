-- Hidden sessions: visible to coaches/managers and to athletes already registered; not listed as open to athletes.

alter table public.training_sessions
  add column if not exists is_hidden boolean not null default false;

drop policy if exists "sessions_select" on public.training_sessions;
create policy "sessions_select" on public.training_sessions for select using (
  public.is_coach_or_manager(auth.uid())
  or exists (
    select 1 from public.session_registrations r
    where r.session_id = training_sessions.id
      and r.user_id = auth.uid()
      and r.status = 'active'
  )
  or (
    is_open_for_registration = true
    and coalesce(is_hidden, false) = false
  )
);

-- Block self-service register / waitlist on hidden sessions (coach can still add athletes).
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
