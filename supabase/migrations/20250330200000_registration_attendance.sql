-- Attendance: coaches/managers mark arrived / absent per active registration; history + reports.

alter table public.session_registrations
  add column if not exists attended boolean null;

comment on column public.session_registrations.attended is
  'null = not recorded yet; true = arrived; false = did not arrive';

-- Coach or manager may set attendance for a session (coach only own sessions).
create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_att boolean;
  v_n int;
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
  elsif p_status = 'arrived' then
    v_att := true;
  else
    v_att := false;
  end if;

  update public.session_registrations
  set attended = v_att
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_attendance(uuid, uuid, text) to authenticated;

-- Participant history: include attendance
create or replace function public.participant_registration_history(
  p_start date,
  p_end date,
  p_phone_search text default null
)
returns table (
  registration_id uuid,
  athlete_user_id uuid,
  athlete_name text,
  athlete_phone text,
  session_id uuid,
  session_date date,
  start_time time,
  duration_minutes int,
  reg_status public.registration_status,
  registered_at timestamptz,
  attended boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  return query
  select
    r.id,
    r.user_id,
    p.full_name,
    p.phone,
    s.id,
    s.session_date,
    s.start_time,
    coalesce(s.duration_minutes, 60)::int,
    r.status,
    r.registered_at,
    r.attended
  from public.session_registrations r
  join public.profiles p on p.user_id = r.user_id
  join public.training_sessions s on s.id = r.session_id
  where p.role = 'athlete'
    and s.session_date >= p_start
    and s.session_date <= p_end
    and (
      p_phone_search is null
      or length(trim(p_phone_search)) = 0
      or p.phone ilike '%' || trim(p_phone_search) || '%'
    )
  union all
  select
    mp.id as registration_id,
    mp.id as athlete_user_id,
    mp.full_name as athlete_name,
    mp.phone as athlete_phone,
    s.id as session_id,
    s.session_date,
    s.start_time,
    coalesce(s.duration_minutes, 60)::int,
    'active'::public.registration_status as reg_status,
    smp.added_at as registered_at,
    smp.attended
  from public.session_manual_participants smp
  join public.manual_participants mp on mp.id = smp.manual_participant_id
  join public.training_sessions s on s.id = smp.session_id
  where s.session_date >= p_start
    and s.session_date <= p_end
    and (
      p_phone_search is null
      or length(trim(p_phone_search)) = 0
      or mp.phone ilike '%' || trim(p_phone_search) || '%'
    )
  order by athlete_name asc, session_date desc, start_time desc;
end;
$$;

grant execute on function public.participant_registration_history(date, date, text) to authenticated;

-- Manager: sessions for a trainer in a date range with registration / arrival counts
create or replace function public.manager_coach_sessions_report(
  p_start date,
  p_end date,
  p_coach_id uuid
)
returns table (
  session_id uuid,
  session_date date,
  start_time time,
  duration_minutes int,
  registered_count int,
  arrived_count int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  return query
  select
    s.id,
    s.session_date,
    s.start_time,
    coalesce(s.duration_minutes, 60)::int,
    (select count(*)::int
     from public.session_registrations r
     where r.session_id = s.id and r.status = 'active') as registered_count,
    (select count(*)::int
     from public.session_registrations r
     where r.session_id = s.id and r.status = 'active' and r.attended is true) as arrived_count
  from public.training_sessions s
  where s.coach_id = p_coach_id
    and s.session_date >= p_start
    and s.session_date <= p_end
  order by s.session_date desc, s.start_time desc;
end;
$$;

grant execute on function public.manager_coach_sessions_report(date, date, uuid) to authenticated;
