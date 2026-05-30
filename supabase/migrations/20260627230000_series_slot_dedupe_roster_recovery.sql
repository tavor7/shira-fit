-- Prevent recurring generator from creating empty duplicate sessions when a detached
-- occurrence (series_id null) already occupies the same date/time/coach slot.
-- Recover existing duplicates by keeping the session that has the roster.

create or replace function public._generate_series_occurrences(
  p_series_id uuid,
  p_from date,
  p_to date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.session_series%rowtype;
  v_d date;
  v_n int := 0;
  v_inserted int := 0;
  v_max_n int := 520;
  v_prev_session uuid;
  v_new_id uuid;
  v_end date;
begin
  select * into s from public.session_series where id = p_series_id;
  if not found or s.status <> 'active' then
    return 0;
  end if;

  v_end := p_to;
  if s.repeat_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_end := least(p_to, s.anchor_date + ((s.fixed_weeks - 1) * 7));
  elsif s.ended_from_date is not null then
    v_end := least(p_to, s.ended_from_date - 1);
  end if;

  while v_n < v_max_n loop
    v_d := s.anchor_date + (v_n * 7);
    exit when v_d > v_end;
    if v_d >= p_from and not (v_d = any (coalesce(s.skip_dates, '{}'::date[]))) then
      -- Any session at this slot (including detached rows with series_id null) blocks generation.
      if not exists (
        select 1 from public.training_sessions t
        where t.session_date = v_d
          and t.start_time = s.start_time
          and t.coach_id = s.coach_id
      ) then
        insert into public.training_sessions (
          session_date,
          start_time,
          coach_id,
          max_participants,
          is_open_for_registration,
          is_hidden,
          is_kickbox,
          custom_slot_price_ils,
          duration_minutes,
          series_id,
          series_detached
        )
        values (
          v_d,
          s.start_time,
          s.coach_id,
          s.max_participants,
          s.is_open_for_registration,
          s.is_hidden,
          s.is_kickbox,
          s.custom_slot_price_ils,
          s.duration_minutes,
          p_series_id,
          false
        )
        returning id into v_new_id;

        v_inserted := v_inserted + 1;

        if s.roster_policy = 'copy_on_generate'::public.session_series_roster_policy then
          select t.id into v_prev_session
          from public.training_sessions t
          where t.series_id = p_series_id
            and t.session_date < v_d
            and t.series_detached = false
          order by t.session_date desc
          limit 1;
          if v_prev_session is not null then
            perform public._copy_session_roster(v_prev_session, v_new_id);
          end if;
        end if;
      end if;
    end if;
    v_n := v_n + 1;
  end loop;

  return v_inserted;
end;
$$;

create or replace function public._session_roster_size(p_session_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((
      select count(*)::int
      from public.session_registrations r
      where r.session_id = p_session_id and r.status = 'active'
    ), 0)
    + coalesce((
      select count(*)::int
      from public.session_manual_participants m
      where m.session_id = p_session_id
    ), 0);
$$;

create or replace function public.reconcile_series_duplicate_sessions()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pair record;
  v_merged int := 0;
  v_deleted int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  for v_pair in
    select
      e.id as empty_id,
      p.id as full_id,
      e.series_id as series_id
    from public.training_sessions e
    join public.training_sessions p
      on p.session_date = e.session_date
     and p.start_time = e.start_time
     and p.coach_id = e.coach_id
     and p.id <> e.id
    where e.series_id is not null
      and public._session_roster_size(e.id) = 0
      and public._session_roster_size(p.id) > 0
      and (p.series_id is null or p.series_detached = true)
  loop
    update public.training_sessions
    set
      series_id = v_pair.series_id,
      series_detached = true
    where id = v_pair.full_id;

    delete from public.training_sessions where id = v_pair.empty_id;
    v_merged := v_merged + 1;
    v_deleted := v_deleted + 1;
  end loop;

  return json_build_object('ok', true, 'merged', v_merged, 'deleted_empty', v_deleted);
end;
$$;

grant execute on function public.reconcile_series_duplicate_sessions() to authenticated;

-- One-time repair on deploy (no auth context during migration).
do $$
declare
  v_pair record;
begin
  for v_pair in
    select
      e.id as empty_id,
      p.id as full_id,
      e.series_id as series_id
    from public.training_sessions e
    join public.training_sessions p
      on p.session_date = e.session_date
     and p.start_time = e.start_time
     and p.coach_id = e.coach_id
     and p.id <> e.id
    where e.series_id is not null
      and public._session_roster_size(e.id) = 0
      and public._session_roster_size(p.id) > 0
      and (p.series_id is null or p.series_detached = true)
  loop
    update public.training_sessions
    set
      series_id = v_pair.series_id,
      series_detached = true
    where id = v_pair.full_id;

    delete from public.training_sessions where id = v_pair.empty_id;
  end loop;
end $$;
