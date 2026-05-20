-- Exclude large-group sessions (max >= 12) from capacity mismatch alerts.

create or replace function public.manager_capacity_mismatch(p_anchor date, p_mode text default 'week')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_start date;
  v_end date;
  v_result json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month') then
    v_mode := 'week';
  end if;

  if v_mode = 'month' then
    v_start := date_trunc('month', p_anchor::timestamp)::date;
    v_end := (v_start + interval '1 month - 1 day')::date;
  else
    v_start := public._week_start_sunday(p_anchor);
    v_end := v_start + 6;
  end if;

  select json_build_object(
    'ok', true,
    'week_start', v_start,
    'week_end', v_end,
    'count', coalesce(count(*)::int, 0),
    'sessions', coalesce(
      json_agg(
        json_build_object(
          'session_id', x.session_id,
          'session_date', x.session_date,
          'start_time', x.start_time::text,
          'duration_minutes', x.duration_minutes,
          'coach_name', x.coach_name,
          'max_participants', x.max_participants,
          'registered_count', x.registered_count
        )
        order by x.session_date asc, x.start_time asc
      ),
      '[]'::json
    )
  )
  into v_result
  from (
    select
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      pr.full_name as coach_name,
      s.max_participants,
      public.active_registration_count(s.id) as registered_count
    from public.training_sessions s
    left join public.profiles pr on pr.user_id = s.coach_id
    where s.session_date between v_start and v_end
      and s.max_participants < 12
      and public._session_has_ended(s)
      and public.active_registration_count(s.id) <> s.max_participants
  ) x;

  return v_result;
end;
$$;
