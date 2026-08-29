-- Surface the expected price for each hidden (session, athlete) pair on the
-- centralized management screen, so the Super User can see how much money
-- was excluded from debt by hiding it. Adding a return column requires
-- dropping the function first (Postgres can't CREATE OR REPLACE across an
-- OUT-column change).

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
  expected_ils numeric
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
    coalesce(public.session_billing_price_ils(s.id, h.user_id), 0)::numeric
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
