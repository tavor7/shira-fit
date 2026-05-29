-- Weekly registration auto-open: use Asia/Jerusalem (studio wall clock), not UTC calendar/time.
-- app_settings.registration_open_weekday/time are interpreted as Israel local day + time.

create or replace function public._studio_today_date()
returns date
language sql
stable
as $$
  select (timezone('Asia/Jerusalem', now()))::date;
$$;

comment on function public._studio_today_date() is
  'Current calendar date in the studio timezone (Asia/Jerusalem).';

create or replace function public._registration_open_at(
  p_week_start_sunday date,
  p_weekday int,
  p_open_time time
)
returns timestamptz
language sql
stable
as $$
  select (
    (
      p_week_start_sunday
      + least(6, greatest(0, coalesce(p_weekday, 4)))
      + coalesce(p_open_time, time '08:00')
    )::timestamp
    at time zone 'Asia/Jerusalem'
  );
$$;

comment on function public._registration_open_at(date, int, time) is
  'Opening instant for a Sun-start week: weekday offset + wall-clock time in Asia/Jerusalem.';

-- Idempotent opener (cron / edge / internal). No auth check.
create or replace function public.open_next_week_sessions_if_due_core()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_today date := public._studio_today_date();
  v_this_week_start date := public._week_start_sunday(v_today);
  v_open_weekday int;
  v_open_time time;
  v_open_at timestamptz;
  v_target_week_start date;
  v_target_week_end date;
  v_n int;
begin
  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := least(6, greatest(0, coalesce(v_open_weekday, 4)));
  v_open_time := coalesce(v_open_time, time '08:00');

  v_open_at := public._registration_open_at(v_this_week_start, v_open_weekday, v_open_time);

  if v_now < v_open_at then
    return json_build_object(
      'ok', true,
      'opened', 0,
      'due', false,
      'open_at', to_char(v_open_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'timezone', 'Asia/Jerusalem'
    );
  end if;

  v_target_week_start := v_this_week_start + 7;
  v_target_week_end := v_target_week_start + 6;

  update public.training_sessions s
  set is_open_for_registration = true
  where s.session_date between v_target_week_start and v_target_week_end
    and coalesce(s.is_hidden, false) = false
    and coalesce(s.is_open_for_registration, false) = false;

  get diagnostics v_n = row_count;
  return json_build_object(
    'ok', true,
    'due', true,
    'opened', v_n,
    'week_start', v_target_week_start::text,
    'week_end', v_target_week_end::text,
    'open_at', to_char(v_open_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'timezone', 'Asia/Jerusalem'
  );
end;
$$;

comment on function public.open_next_week_sessions_if_due_core() is
  'Opens next Sun–Sat non-hidden sessions when studio-local opening time has passed. Safe to call repeatedly.';

revoke all on function public.open_next_week_sessions_if_due_core() from public;
grant execute on function public.open_next_week_sessions_if_due_core() to service_role;
grant execute on function public.open_next_week_sessions_if_due_core() to postgres;

create or replace function public.open_next_week_sessions_if_due()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  return public.open_next_week_sessions_if_due_core();
end;
$$;

grant execute on function public.open_next_week_sessions_if_due() to authenticated;

create or replace function public.get_next_weekly_registration_banner_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_today date := public._studio_today_date();
  v_this_week_start date;
  v_open_weekday int;
  v_open_time time;
  v_open_at timestamptz;
  v_next_open timestamptz;
  v_next_unlock_start date;
  v_next_unlock_end date;
  v_current_unlock_start date;
  v_current_unlock_end date;
  v_eligible_next int;
  v_open_next int;
  v_eligible_current int;
  v_open_current int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.user_id = v_uid
      and p.role = 'athlete'
      and p.approval_status = 'approved'
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_this_week_start := public._week_start_sunday(v_today);

  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := coalesce(least(6, greatest(0, v_open_weekday)), 4);
  v_open_time := coalesce(v_open_time, time '08:00'::time);

  v_open_at := public._registration_open_at(v_this_week_start, v_open_weekday, v_open_time);

  v_current_unlock_start := v_this_week_start + 7;
  v_current_unlock_end := v_current_unlock_start + 6;

  if v_now < v_open_at then
    v_next_open := v_open_at;
    v_next_unlock_start := v_this_week_start + 7;
  else
    v_next_open := v_open_at + interval '7 days';
    v_next_unlock_start := v_this_week_start + 14;
  end if;
  v_next_unlock_end := v_next_unlock_start + 6;

  select count(*)::int into v_eligible_next
  from public.training_sessions s
  where s.session_date between v_next_unlock_start and v_next_unlock_end
    and coalesce(s.is_hidden, false) = false;

  select count(*)::int into v_open_next
  from public.training_sessions s
  where s.session_date between v_next_unlock_start and v_next_unlock_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = true;

  select count(*)::int into v_eligible_current
  from public.training_sessions s
  where s.session_date between v_current_unlock_start and v_current_unlock_end
    and coalesce(s.is_hidden, false) = false;

  select count(*)::int into v_open_current
  from public.training_sessions s
  where s.session_date between v_current_unlock_start and v_current_unlock_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = true;

  return jsonb_build_object(
    'ok', true,
    'next_open_at_utc', to_char(v_next_open, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'next_unlock_week_start', to_char(v_next_unlock_start, 'YYYY-MM-DD'),
    'next_unlock_week_end', to_char(v_next_unlock_end, 'YYYY-MM-DD'),
    'current_unlock_week_start', to_char(v_current_unlock_start, 'YYYY-MM-DD'),
    'current_unlock_week_end', to_char(v_current_unlock_end, 'YYYY-MM-DD'),
    'eligible_next_week_count', v_eligible_next,
    'open_next_week_count', v_open_next,
    'eligible_current_week_count', v_eligible_current,
    'open_current_week_count', v_open_current,
    'show_registration_countdown', (v_eligible_next > 0 and v_now < v_next_open),
    'show_registration_still_pending', (
      v_eligible_current > 0
      and v_now >= v_open_at
      and v_open_current < v_eligible_current
    ),
    'timezone', 'Asia/Jerusalem'
  );
end;
$$;

comment on function public.get_next_weekly_registration_banner_state() is
  'Athletes only. Weekly registration schedule from app_settings (Asia/Jerusalem). '
  'next_open_at_utc is an RFC3339 instant (field name kept for clients).';

grant execute on function public.get_next_weekly_registration_banner_state() to authenticated;

comment on column public.app_settings.registration_open_time is
  'Studio-local wall-clock time (Asia/Jerusalem) on registration_open_weekday each week.';

-- Cron: poll every 15 minutes so DST and opening checks stay correct without rescheduling UTC crons.
create or replace function public.reschedule_open_weekly_registrations_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id int;
begin
  select j.jobid into v_job_id
  from cron.job j
  where j.jobname = 'open-weekly-registrations'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'open-weekly-registrations',
    '*/15 * * * *',
    $job$select public.open_next_week_sessions_if_due_core();$job$
  );
end;
$$;

comment on function public.reschedule_open_weekly_registrations_cron() is
  'Schedules idempotent open_next_week_sessions_if_due_core every 15 minutes (studio TZ logic inside).';

select public.reschedule_open_weekly_registrations_cron();
