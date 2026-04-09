-- Weekly "open registrations" automation + manager manual open for a week.
-- Schedule is stored in app_settings as weekday (0=Sun..6=Sat) + time (UTC).

create or replace function public._week_start_sunday(d date)
returns date
language sql
stable
as $$
  select (d - (extract(dow from d)::int))::date;
$$;

create or replace function public.open_sessions_for_week(p_week_start date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_start date;
  v_end date;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_week_start is null then return json_build_object('ok', false, 'error', 'invalid_week_start'); end if;

  v_start := public._week_start_sunday(p_week_start);
  v_end := (v_start + 6);

  update public.training_sessions s
  set is_open_for_registration = true
  where s.session_date between v_start and v_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = false;

  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'opened', v_n, 'week_start', v_start::text, 'week_end', v_end::text);
end;
$$;

grant execute on function public.open_sessions_for_week(date) to authenticated;

-- Opportunistic auto-opener:
-- Any authenticated user can call it; it only opens sessions when "now UTC" is past the configured opening.
create or replace function public.open_next_week_sessions_if_due()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now_utc timestamp := (now() at time zone 'utc');
  v_today_utc date := (now() at time zone 'utc')::date;
  v_this_week_start date := public._week_start_sunday(v_today_utc);
  v_open_weekday int;
  v_open_time time;
  v_open_ts timestamp;
  v_target_week_start date;
  v_target_week_end date;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  -- Opening time is in UTC.
  v_open_ts := (v_this_week_start + v_open_weekday) + v_open_time;

  if v_now_utc < v_open_ts then
    return json_build_object(
      'ok', true,
      'opened', 0,
      'due', false,
      'open_at_utc', to_char(v_open_ts, 'YYYY-MM-DD\"T\"HH24:MI:SS')
    );
  end if;

  v_target_week_start := v_this_week_start + 7;
  v_target_week_end := v_target_week_start + 6;

  update public.training_sessions s
  set is_open_for_registration = true
  where s.session_date between v_target_week_start and v_target_week_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = false;

  get diagnostics v_n = row_count;
  return json_build_object(
    'ok', true,
    'due', true,
    'opened', v_n,
    'week_start', v_target_week_start::text,
    'week_end', v_target_week_end::text
  );
end;
$$;

grant execute on function public.open_next_week_sessions_if_due() to authenticated;

