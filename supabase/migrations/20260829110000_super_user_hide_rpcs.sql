-- Super User hide/unhide RPCs and the two read RPCs backing the session-detail
-- toggle and the centralized hidden-workouts management screen.
--
-- Every function re-checks is_super_user(auth.uid()) internally even though
-- the underlying table already has an RLS policy restricting it to the Super
-- User: RPCs are security definer and the "forbidden" JSON response is a
-- clearer client-side contract than a silent empty result from RLS alone.

create or replace function public.super_user_hide_registration(p_session_id uuid, p_user_id uuid)
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
  if not exists (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'registration_not_found');
  end if;

  insert into public.super_user_hidden_registrations (session_id, user_id, hidden_by)
  values (p_session_id, p_user_id, v_uid)
  on conflict (session_id, user_id) where unhidden_at is null do nothing;

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.super_user_hide_registration(uuid, uuid) to authenticated;

create or replace function public.super_user_unhide_registration(p_session_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_updated int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_super_user(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.super_user_hidden_registrations
  set unhidden_at = now(), unhidden_by = v_uid
  where session_id = p_session_id and user_id = p_user_id and unhidden_at is null;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return json_build_object('ok', false, 'error', 'not_hidden');
  end if;

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.super_user_unhide_registration(uuid, uuid) to authenticated;

-- Which currently-registered athletes on this session are hidden right now.
-- Used by the Super User's session-detail view to render the toggle state.
create or replace function public.super_user_list_hidden_for_session(p_session_id uuid)
returns table (user_id uuid, hidden_at timestamptz)
language sql stable security definer set search_path = public as $$
  select h.user_id, h.hidden_at
  from public.super_user_hidden_registrations h
  where h.session_id = p_session_id
    and h.unhidden_at is null
    and public.is_super_user(auth.uid());
$$;
grant execute on function public.super_user_list_hidden_for_session(uuid) to authenticated;

-- Centralized management screen: combinable athlete + date-range filters.
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
  unhidden_by_name text
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
    ub.full_name
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
