-- Phase 2: skip dates, edit/delete with this-only vs future scope.

alter table public.session_series
  add column if not exists skip_dates date[] not null default '{}';

comment on column public.session_series.skip_dates is
  'Occurrence dates excluded from generation (e.g. after a one-off delete).';

-- Regenerate with skip_dates support.
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
      if not exists (
        select 1 from public.training_sessions t
        where t.series_id = p_series_id and t.session_date = v_d
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

create or replace function public.staff_delete_session_series_scope(
  p_session_id uuid,
  p_scope text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  if v_sess.series_id is null then
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    update public.session_series
    set skip_dates = (
      select array_agg(distinct d order by d)
      from (
        select unnest(coalesce(skip_dates, '{}'::date[])) as d
        union all
        select v_sess.session_date
      ) u
    )
    where id = v_sess.series_id;

    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  update public.session_series
  set
    status = 'ended',
    ended_from_date = v_sess.session_date,
    updated_at = now()
  where id = v_sess.series_id;

  delete from public.training_sessions t
  where t.series_id = v_sess.series_id
    and t.session_date >= v_sess.session_date
    and t.series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

grant execute on function public.staff_delete_session_series_scope(uuid, text) to authenticated;

create or replace function public.staff_update_session_series_scope(
  p_session_id uuid,
  p_scope text,
  p_session_date date,
  p_start_time time,
  p_coach_id uuid,
  p_max_participants int,
  p_duration_minutes int,
  p_is_open boolean,
  p_is_hidden boolean,
  p_is_kickbox boolean,
  p_custom_slot_price_ils numeric default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_dur int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  v_dur := greatest(1, coalesce(p_duration_minutes, 60));

  if v_sess.series_id is null then
    update public.training_sessions
    set
      session_date = coalesce(p_session_date, session_date),
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils
    where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    update public.training_sessions
    set
      session_date = coalesce(p_session_date, session_date),
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils,
      series_detached = true
    where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  update public.session_series
  set
    coach_id = coalesce(p_coach_id, coach_id),
    start_time = coalesce(p_start_time, start_time),
    duration_minutes = v_dur,
    max_participants = coalesce(p_max_participants, max_participants),
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils,
    updated_at = now()
  where id = v_sess.series_id;

  update public.training_sessions
  set
    session_date = coalesce(p_session_date, session_date),
    start_time = coalesce(p_start_time, start_time),
    coach_id = coalesce(p_coach_id, coach_id),
    max_participants = coalesce(p_max_participants, max_participants),
    duration_minutes = v_dur,
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils
  where series_id = v_sess.series_id
    and session_date >= v_sess.session_date
    and series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

grant execute on function public.staff_update_session_series_scope(
  uuid, text, date, time, uuid, int, int, boolean, boolean, boolean, numeric
) to authenticated;
