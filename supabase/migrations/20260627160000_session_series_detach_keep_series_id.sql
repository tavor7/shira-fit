-- Fix: "edit only this session" should not null series_id.
-- If series_id is nulled, deleting the edited occurrence allows the generator
-- to recreate the original base occurrence, making it look like the session "came back".
--
-- Also: if the edited occurrence changes date, add the original date to skip_dates
-- so the base occurrence does not regenerate at the old date.

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
  v_new_date date;
  v_old_date date;
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
  v_new_date := coalesce(p_session_date, v_sess.session_date);
  v_old_date := v_sess.session_date;

  if v_sess.series_id is null then
    update public.training_sessions
    set
      session_date = v_new_date,
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
    if v_new_date <> v_old_date then
      if exists (
        select 1 from public.training_sessions t
        where t.series_id = v_sess.series_id
          and t.session_date = v_new_date
          and t.id <> p_session_id
      ) then
        return json_build_object('ok', false, 'error', 'series_date_conflict');
      end if;

      -- prevent base occurrence from regenerating at the old date
      update public.session_series
      set skip_dates = (
        select array_agg(distinct d order by d)
        from (
          select unnest(coalesce(skip_dates, '{}'::date[])) as d
          union all
          select v_old_date
        ) u
      )
      where id = v_sess.series_id;
    end if;

    update public.training_sessions
    set
      session_date = v_new_date,
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils,
      series_detached = true
      -- IMPORTANT: keep series_id so deletion can mark skip_dates
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

  -- Apply template fields to future occurrences; keep each row's own session_date.
  update public.training_sessions
  set
    start_time = coalesce(p_start_time, start_time),
    coach_id = coalesce(p_coach_id, coach_id),
    max_participants = coalesce(p_max_participants, max_participants),
    duration_minutes = v_dur,
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils
  where series_id = v_sess.series_id
    and session_date >= v_old_date
    and series_detached = false;

  -- Date changes apply only to the edited occurrence (other weeks stay on their dates).
  if v_new_date <> v_old_date then
    if exists (
      select 1 from public.training_sessions t
      where t.series_id = v_sess.series_id
        and t.session_date = v_new_date
        and t.id <> p_session_id
    ) then
      return json_build_object('ok', false, 'error', 'series_date_conflict');
    end if;

    -- prevent base occurrence from regenerating at the old date
    update public.session_series
    set skip_dates = (
      select array_agg(distinct d order by d)
      from (
        select unnest(coalesce(skip_dates, '{}'::date[])) as d
        union all
        select v_old_date
      ) u
    )
    where id = v_sess.series_id;

    update public.training_sessions
    set
      session_date = v_new_date,
      series_detached = true
      -- keep series_id
    where id = p_session_id;
  else
    -- still mark as detached so future edits don't propagate
    update public.training_sessions
    set series_detached = true
    where id = p_session_id;
  end if;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

