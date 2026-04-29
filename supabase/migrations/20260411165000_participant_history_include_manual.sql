-- Extend participant_registration_history to include manual participants (quick-add).
-- This enables "trainee reports" to show history for quick-added trainees even before
-- they have a linked auth account.

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
  (
    -- Auth athletes registrations
    select
      r.id,
      r.user_id as athlete_user_id,
      p.full_name as athlete_name,
      p.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      r.status as reg_status,
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

    union all

    -- Manual participants (quick-add): treat as "active" registrations.
    select
      smp.id as registration_id,
      smp.manual_participant_id as athlete_user_id,
      mp.full_name as athlete_name,
      mp.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      'active'::public.registration_status as reg_status,
      smp.added_at as registered_at
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
  )
  order by athlete_name asc, session_date desc, start_time desc;
end;
$$;

grant execute on function public.participant_registration_history(date, date, text) to authenticated;

