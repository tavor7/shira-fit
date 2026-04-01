-- Fix participant counts (include manual participants), capacity checks, removals, and attendance payment method.

-- 1) Count active participants in a session (registered + manual).
create or replace function public.active_registration_count(sid uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select
    (
      select count(*)::int
      from public.session_registrations r
      where r.session_id = sid and r.status = 'active'
    )
    +
    (
      select count(*)::int
      from public.session_manual_participants mp
      where mp.session_id = sid
    );
$$;

-- 2) Enforce capacity + duplicate detection for manual participant add.
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

grant execute on function public.add_manual_participant_to_session(uuid, uuid) to authenticated;

-- 3) Staff removals (coach can remove from own session; manager can remove any).
create or replace function public.coach_remove_athlete(p_session_id uuid, p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.session_registrations
  set status = 'cancelled'
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then return json_build_object('ok', false, 'error', 'not_active'); end if;

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'removed');

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.coach_remove_athlete(uuid, uuid) to authenticated;

create or replace function public.remove_manual_participant_from_session(
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
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  delete from public.session_manual_participants
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then return json_build_object('ok', false, 'error', 'not_in_session'); end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.remove_manual_participant_from_session(uuid, uuid) to authenticated;

-- 4) Attendance payment method.
alter table public.session_registrations
  add column if not exists payment_method text null;

alter table public.session_manual_participants
  add column if not exists payment_method text null;

create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text,
  p_payment_method text default null
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid
    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
  elsif p_status = 'arrived' then
    v_att := true;
  else
    v_att := false;
    v_pay := null;
  end if;

  update public.session_registrations
  set attended = v_att,
      payment_method = v_pay
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_attendance(uuid, uuid, text, text) to authenticated;

create or replace function public.set_manual_participant_attendance(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_status text,
  p_payment_method text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
  elsif p_status = 'arrived' then
    v_att := true;
  else
    v_att := false;
    v_pay := null;
  end if;

  update public.session_manual_participants
  set attended = v_att,
      payment_method = v_pay
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_in_session');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_manual_participant_attendance(uuid, uuid, text, text) to authenticated;

