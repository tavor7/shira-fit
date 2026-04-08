-- Manager bulk actions for sessions calendar:
-- 1) Clear all sessions for a day (deletes sessions; cascades remove registrations/waitlists/etc).
-- 2) Duplicate all sessions from one day to another (copies schedule only; no participants; registration closed).

create or replace function public.manager_clear_sessions_for_day(p_date date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  delete from public.training_sessions s
  where s.session_date = p_date;

  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'deleted', v_n);
end;
$$;

grant execute on function public.manager_clear_sessions_for_day(date) to authenticated;

create or replace function public.manager_duplicate_sessions_day(p_from_date date, p_to_date date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_has_target boolean;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_from_date is null or p_to_date is null then
    return json_build_object('ok', false, 'error', 'invalid_dates');
  end if;
  if p_from_date = p_to_date then
    return json_build_object('ok', false, 'error', 'same_day');
  end if;

  select exists(select 1 from public.training_sessions s where s.session_date = p_to_date) into v_has_target;
  if v_has_target then
    return json_build_object('ok', false, 'error', 'target_not_empty');
  end if;

  insert into public.training_sessions (
    session_date,
    start_time,
    coach_id,
    max_participants,
    is_open_for_registration,
    duration_minutes,
    is_hidden
  )
  select
    p_to_date as session_date,
    s.start_time,
    s.coach_id,
    s.max_participants,
    false as is_open_for_registration,
    s.duration_minutes,
    coalesce(s.is_hidden, false) as is_hidden
  from public.training_sessions s
  where s.session_date = p_from_date;

  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'created', v_n);
end;
$$;

grant execute on function public.manager_duplicate_sessions_day(date, date) to authenticated;

