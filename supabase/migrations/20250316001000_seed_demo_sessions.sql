-- Seed demo training sessions + one active registration, so the calendar views have data.
-- This migration is safe to re-run: it avoids duplicates by (coach_id, session_date, start_time).

do $$
declare
  v_coach uuid;
  v_athlete uuid;
  week_start date;
begin
  -- Pick any existing coach/manager as the session coach.
  select user_id into v_coach
  from public.profiles
  where role in ('coach', 'manager')
  order by created_at asc
  limit 1;

  -- Pick any existing athlete as the registering user (for "My sessions").
  select user_id into v_athlete
  from public.profiles
  where role = 'athlete'
  order by created_at asc
  limit 1;

  if v_coach is null then
    -- No coaches exist yet; nothing to seed.
    return;
  end if;

  week_start := current_date - extract(dow from current_date)::int; -- Sunday start (dow: 0=Sunday)

  -- Current week (Sun..Sat) examples
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  select (week_start + 1)::date, time '18:00', v_coach, 10, true
  where not exists (
    select 1 from public.training_sessions ts
    where ts.coach_id = v_coach and ts.session_date = (week_start + 1)::date and ts.start_time = time '18:00'
  );

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  select (week_start + 2)::date, time '19:00', v_coach, 10, true
  where not exists (
    select 1 from public.training_sessions ts
    where ts.coach_id = v_coach and ts.session_date = (week_start + 2)::date and ts.start_time = time '19:00'
  );

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  select (week_start + 4)::date, time '18:30', v_coach, 5, false
  where not exists (
    select 1 from public.training_sessions ts
    where ts.coach_id = v_coach and ts.session_date = (week_start + 4)::date and ts.start_time = time '18:30'
  );

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  select (week_start + 5)::date, time '20:00', v_coach, 10, true
  where not exists (
    select 1 from public.training_sessions ts
    where ts.coach_id = v_coach and ts.session_date = (week_start + 5)::date and ts.start_time = time '20:00'
  );

  -- Next week example
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  select (week_start + 7 + 2)::date, time '18:00', v_coach, 10, true
  where not exists (
    select 1 from public.training_sessions ts
    where ts.coach_id = v_coach
      and ts.session_date = (week_start + 7 + 2)::date
      and ts.start_time = time '18:00'
  );

  -- Add one active registration so "My sessions" has at least one item.
  if v_athlete is not null then
    insert into public.session_registrations (session_id, user_id, status)
    select
      ts.id,
      v_athlete,
      'active'::public.registration_status
    from public.training_sessions ts
    where ts.coach_id = v_coach
      and ts.session_date = (week_start + 1)::date
      and ts.start_time = time '18:00'
      and not exists (
        select 1 from public.session_registrations r
        where r.session_id = ts.id and r.user_id = v_athlete
      );
  end if;
end $$;

