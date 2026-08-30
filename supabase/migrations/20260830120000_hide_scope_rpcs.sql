-- Hide RPC now takes an explicit per-audience scope. Re-hiding an already-hidden
-- (session, athlete) pair updates its scope in place instead of being a no-op,
-- so the Super User can adjust who it's hidden from without unhiding first.

drop function if exists public.super_user_hide_registration(uuid, uuid);

create or replace function public.super_user_hide_registration(
  p_session_id uuid,
  p_user_id uuid,
  p_hide_from_athlete boolean default true,
  p_hide_from_coach boolean default false,
  p_hide_from_manager boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_super_user(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not (p_hide_from_athlete or p_hide_from_coach or p_hide_from_manager) then
    return json_build_object('ok', false, 'error', 'no_scope_selected');
  end if;
  if not exists (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'registration_not_found');
  end if;

  insert into public.super_user_hidden_registrations
    (session_id, user_id, hidden_by, hide_from_athlete, hide_from_coach, hide_from_manager)
  values (p_session_id, p_user_id, v_uid, p_hide_from_athlete, p_hide_from_coach, p_hide_from_manager)
  on conflict (session_id, user_id) where unhidden_at is null
  do update set
    hide_from_athlete = excluded.hide_from_athlete,
    hide_from_coach = excluded.hide_from_coach,
    hide_from_manager = excluded.hide_from_manager,
    hidden_by = excluded.hidden_by,
    hidden_at = now();

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.super_user_hide_registration(uuid, uuid, boolean, boolean, boolean) to authenticated;

drop function if exists public.super_user_list_hidden_for_session(uuid);

create or replace function public.super_user_list_hidden_for_session(p_session_id uuid)
returns table (
  user_id uuid,
  hidden_at timestamptz,
  hide_from_athlete boolean,
  hide_from_coach boolean,
  hide_from_manager boolean
)
language sql stable security definer set search_path = public as $$
  select h.user_id, h.hidden_at, h.hide_from_athlete, h.hide_from_coach, h.hide_from_manager
  from public.super_user_hidden_registrations h
  where h.session_id = p_session_id
    and h.unhidden_at is null
    and public.is_super_user(auth.uid());
$$;
grant execute on function public.super_user_list_hidden_for_session(uuid) to authenticated;

drop function if exists public.super_user_list_hidden_records(uuid, date, date, boolean);

create or replace function public.super_user_list_hidden_records(
  p_athlete_id uuid default null,
  p_start date default null,
  p_end date default null,
  p_include_unhidden boolean default false
)
returns table (
  hide_id uuid,
  session_id uuid,
  athlete_user_id uuid,
  athlete_name text,
  session_date date,
  start_time time,
  duration_minutes int,
  coach_name text,
  hidden_at timestamptz,
  hidden_by_name text,
  unhidden_at timestamptz,
  unhidden_by_name text,
  expected_ils numeric,
  hide_from_athlete boolean,
  hide_from_coach boolean,
  hide_from_manager boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_user(auth.uid()) then
    return;
  end if;

  return query
  select
    h.id,
    h.session_id,
    h.user_id,
    p.full_name,
    s.session_date,
    s.start_time,
    coalesce(s.duration_minutes, 60)::int,
    coach.full_name,
    h.hidden_at,
    hb.full_name,
    h.unhidden_at,
    ub.full_name,
    coalesce(public.session_billing_price_ils(s.id, h.user_id), 0)::numeric,
    h.hide_from_athlete,
    h.hide_from_coach,
    h.hide_from_manager
  from public.super_user_hidden_registrations h
  join public.profiles p on p.user_id = h.user_id
  join public.training_sessions s on s.id = h.session_id
  left join public.profiles coach on coach.user_id = s.coach_id
  left join public.profiles hb on hb.user_id = h.hidden_by
  left join public.profiles ub on ub.user_id = h.unhidden_by
  where (p_include_unhidden or h.unhidden_at is null)
    and (p_athlete_id is null or h.user_id = p_athlete_id)
    and (p_start is null or s.session_date >= p_start)
    and (p_end is null or s.session_date <= p_end)
  order by h.hidden_at desc;
end;
$$;
grant execute on function public.super_user_list_hidden_records(uuid, date, date, boolean) to authenticated;
