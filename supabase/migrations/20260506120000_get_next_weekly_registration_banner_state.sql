-- Read-only banner state for athlete home: next weekly registration opening (UTC) and
-- whether target-week sessions are still closed (manager manual / edge cases).
-- Semantics match open_next_week_sessions_if_due: opening instant is
--   _week_start_sunday(today_utc) + registration_open_weekday + registration_open_time;
-- the Thursday run opens the following Sun–Sat week (this_week_start + 7 .. + 13).

create or replace function public.get_next_weekly_registration_banner_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now_utc timestamp := (now() at time zone 'utc');
  v_today_utc date := (now() at time zone 'utc')::date;
  v_this_week_start date;
  v_open_weekday int;
  v_open_time time;
  v_open_ts timestamp;
  v_next_open timestamp;
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

  v_this_week_start := public._week_start_sunday(v_today_utc);

  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := coalesce(least(6, greatest(0, v_open_weekday)), 4);
  v_open_time := coalesce(v_open_time, '08:00'::time);

  v_open_ts := (v_this_week_start + v_open_weekday) + v_open_time;

  v_current_unlock_start := v_this_week_start + 7;
  v_current_unlock_end := v_current_unlock_start + 6;

  if v_now_utc < v_open_ts then
    v_next_open := v_open_ts;
    v_next_unlock_start := v_this_week_start + 7;
  else
    v_next_open := v_open_ts + interval '7 days';
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
    'next_open_at_utc', to_char(v_next_open, 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z',
    'next_unlock_week_start', to_char(v_next_unlock_start, 'YYYY-MM-DD'),
    'next_unlock_week_end', to_char(v_next_unlock_end, 'YYYY-MM-DD'),
    'current_unlock_week_start', to_char(v_current_unlock_start, 'YYYY-MM-DD'),
    'current_unlock_week_end', to_char(v_current_unlock_end, 'YYYY-MM-DD'),
    'eligible_next_week_count', v_eligible_next,
    'open_next_week_count', v_open_next,
    'eligible_current_week_count', v_eligible_current,
    'open_current_week_count', v_open_current,
    'show_registration_countdown', (v_eligible_next > 0 and v_now_utc < v_next_open),
    'show_registration_still_pending', (
      v_eligible_current > 0
      and v_now_utc >= v_open_ts
      and v_open_current < v_eligible_current
    )
  );
end;
$$;

comment on function public.get_next_weekly_registration_banner_state() is
  'Athletes only. UTC weekly registration schedule from app_settings. '
  'show_registration_countdown: before next opening instant and next unlock week has sessions. '
  'show_registration_still_pending: after this week''s opening time, current unlock week has sessions still closed.';

grant execute on function public.get_next_weekly_registration_banner_state() to authenticated;
