-- Safer recurring-slot duplicate handling:
-- 1) Reconcile empty ghost sessions at the same coach/date/time as a rostered sibling.
-- 2) Exclude those ghosts from capacity-mismatch overview (coach pay was already 0).
-- 3) Unique slot index prevents new duplicates without touching valid series rows.
-- 4) Run reconcile after horizon top-up (recurring generation).

create or replace function public._session_slot_key(
  p_coach_id uuid,
  p_session_date date,
  p_start_time time
)
returns text
language sql
immutable
as $$
  select coalesce(p_coach_id::text, '') || '|' || coalesce(p_session_date::text, '') || '|' || coalesce(p_start_time::text, '');
$$;

create or replace function public._session_is_slot_roster_ghost(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.training_sessions s
    join public.training_sessions s2
      on s2.coach_id = s.coach_id
     and s2.session_date = s.session_date
     and s2.start_time = s.start_time
     and s2.id <> s.id
    where s.id = p_session_id
      and public._session_roster_size(s.id) = 0
      and public._session_roster_size(s2.id) > 0
  );
$$;

comment on function public._session_is_slot_roster_ghost(uuid) is
  'True when this session is empty but another row exists at the same coach/date/time with a roster.';

create or replace function public._reconcile_slot_duplicate_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot record;
  v_sess record;
  v_keeper_id uuid;
  v_keeper_roster int;
  v_deleted int := 0;
  v_roster int;
begin
  for v_slot in
    select s.coach_id, s.session_date, s.start_time
    from public.training_sessions s
    group by s.coach_id, s.session_date, s.start_time
    having count(*) > 1
  loop
    select t.id, public._session_roster_size(t.id)
    into v_keeper_id, v_keeper_roster
    from public.training_sessions t
    where t.coach_id = v_slot.coach_id
      and t.session_date = v_slot.session_date
      and t.start_time = v_slot.start_time
    order by
      public._session_roster_size(t.id) desc,
      case when t.series_detached then 1 else 0 end desc,
      case when t.series_id is null then 0 else 1 end desc,
      t.created_at asc nulls last,
      t.id asc
    limit 1;

    if v_keeper_id is null then
      continue;
    end if;

    for v_sess in
      select t.id, t.series_id, public._session_roster_size(t.id) as roster
      from public.training_sessions t
      where t.coach_id = v_slot.coach_id
        and t.session_date = v_slot.session_date
        and t.start_time = v_slot.start_time
        and t.id <> v_keeper_id
    loop
      v_roster := v_sess.roster;

      -- Never delete a second rostered row automatically.
      if v_roster > 0 and v_keeper_roster > 0 then
        continue;
      end if;

      if v_sess.series_id is not null then
        perform public._series_add_skip_date(v_sess.series_id, v_slot.session_date);

        if v_keeper_roster > 0 then
          update public.training_sessions k
          set
            series_id = coalesce(k.series_id, v_sess.series_id),
            series_detached = true
          where k.id = v_keeper_id
            and (k.series_id is null or k.series_detached = false);
        end if;
      end if;

      delete from public.training_sessions where id = v_sess.id;
      v_deleted := v_deleted + 1;
    end loop;
  end loop;

  return v_deleted;
end;
$$;

create or replace function public.reconcile_series_duplicate_sessions()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_deleted := public._reconcile_slot_duplicate_sessions();
  return json_build_object('ok', true, 'deleted_empty', v_deleted);
end;
$$;

grant execute on function public.reconcile_series_duplicate_sessions() to authenticated;

create or replace function public.maintain_session_series_horizon()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_total int := 0;
  v_n int;
  v_from date;
  v_to date;
  v_reconciled int := 0;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_from := public._studio_today_date();
  v_to := public._series_horizon_end();

  for s in
    select id from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    v_n := public._generate_series_occurrences(s.id, v_from, v_to);
    v_total := v_total + coalesce(v_n, 0);
  end loop;

  v_reconciled := public._reconcile_slot_duplicate_sessions();

  return json_build_object('ok', true, 'created', v_total, 'reconciled', v_reconciled);
end;
$$;

grant execute on function public.maintain_session_series_horizon() to authenticated;

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
  if v_mode not in ('week', 'month', 'global') then
    v_mode := 'week';
  end if;

  select b.period_start, b.period_end into v_start, v_end
  from public._manager_stats_period_bounds(p_anchor, v_mode) b;

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
      and not public._session_is_slot_roster_ghost(s.id)
  ) x;

  return v_result;
end;
$$;

grant execute on function public.manager_capacity_mismatch(date, text) to authenticated;

-- One-time cleanup before enforcing unique coach/date/time slots.
select public._reconcile_slot_duplicate_sessions();

create unique index if not exists training_sessions_coach_slot_uidx
  on public.training_sessions (coach_id, session_date, start_time);

comment on index public.training_sessions_coach_slot_uidx is
  'One session per coach per calendar slot; prevents recurring ghost duplicates.';
