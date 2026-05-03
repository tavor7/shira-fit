-- Coach history report: per-session count of self-cancellations in the <24h window
-- (same business rule as `cancellations.charged_full_price` from cancel_registration).

drop function if exists public.manager_coach_sessions_report(date, date, uuid);

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
  arrived_count int,
  late_cancellations_within_24h int
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
     where r.session_id = s.id and r.status = 'active' and r.attended is true) as arrived_count,
    (select count(*)::int
     from public.cancellations c
     where c.session_id = s.id and c.charged_full_price is true) as late_cancellations_within_24h
  from public.training_sessions s
  where s.coach_id = p_coach_id
    and s.session_date >= p_start
    and s.session_date <= p_end
  order by s.session_date desc, s.start_time desc;
end;
$$;

grant execute on function public.manager_coach_sessions_report(date, date, uuid) to authenticated;
