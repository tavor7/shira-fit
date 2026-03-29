-- Coaches and managers: list session registrations in a date range, optional phone filter.
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
  registered_at timestamptz
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
    r.registered_at
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
  order by p.full_name asc, s.session_date desc, s.start_time desc;
end;
$$;

grant execute on function public.participant_registration_history(date, date, text) to authenticated;
