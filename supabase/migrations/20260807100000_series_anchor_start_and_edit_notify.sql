-- 1) Recurring series creation must generate occurrences starting exactly at the
--    staff-selected anchor date. Previously "ongoing" series clamped the generation
--    start to greatest(anchor_date, today), which could substitute a different
--    (e.g. current-week) occurrence for the one actually selected. Generation now
--    always starts at p_anchor_date for both repeat modes; the rolling horizon
--    (public._series_horizon_end()) still bounds how far ahead occurrences are
--    materialized.
create or replace function public.staff_create_session_series(
  p_anchor_date date,
  p_start_time time,
  p_coach_id uuid,
  p_max_participants int,
  p_duration_minutes int default 60,
  p_is_open boolean default false,
  p_is_hidden boolean default false,
  p_is_kickbox boolean default false,
  p_custom_slot_price_ils numeric default null,
  p_repeat_mode text default 'ongoing',
  p_fixed_weeks int default null,
  p_copy_roster boolean default false,
  p_athlete_ids uuid[] default '{}',
  p_manual_ids uuid[] default '{}'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode public.session_series_repeat_mode;
  v_weeks int;
  v_series_id uuid;
  v_from date;
  v_to date;
  v_roster public.session_series_roster_policy;
  v_first_session uuid;
  v_sid uuid;
  v_ids uuid[] := '{}';
  v_a uuid;
  v_m uuid;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_anchor_date is null or p_coach_id is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_max_participants is null or p_max_participants < 1 then
    return json_build_object('ok', false, 'error', 'invalid_capacity');
  end if;

  v_mode := case lower(trim(coalesce(p_repeat_mode, 'ongoing')))
    when 'fixed_weeks' then 'fixed_weeks'::public.session_series_repeat_mode
    when 'fixed' then 'fixed_weeks'::public.session_series_repeat_mode
    else 'ongoing'::public.session_series_repeat_mode
  end;

  if v_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_weeks := coalesce(p_fixed_weeks, 4);
    if v_weeks < 1 then v_weeks := 1; end if;
    if v_weeks > 52 then v_weeks := 52; end if;
  else
    v_weeks := null;
  end if;

  v_roster := case
    when not coalesce(p_copy_roster, false) then 'none'::public.session_series_roster_policy
    when v_mode = 'ongoing'::public.session_series_repeat_mode then 'copy_on_generate'::public.session_series_roster_policy
    else 'copy_on_create'::public.session_series_roster_policy
  end;

  insert into public.session_series (
    coach_id,
    anchor_date,
    start_time,
    duration_minutes,
    max_participants,
    is_open_for_registration,
    is_hidden,
    is_kickbox,
    custom_slot_price_ils,
    repeat_mode,
    fixed_weeks,
    roster_policy,
    status,
    created_by
  )
  values (
    p_coach_id,
    p_anchor_date,
    p_start_time,
    greatest(1, coalesce(p_duration_minutes, 60)),
    p_max_participants,
    coalesce(p_is_open, false),
    coalesce(p_is_hidden, false),
    coalesce(p_is_kickbox, false),
    p_custom_slot_price_ils,
    v_mode,
    v_weeks,
    v_roster,
    'active',
    v_uid
  )
  returning id into v_series_id;

  v_from := p_anchor_date;
  if v_mode = 'ongoing'::public.session_series_repeat_mode then
    v_to := public._series_horizon_end();
  else
    v_to := p_anchor_date + ((v_weeks - 1) * 7);
  end if;

  perform public._generate_series_occurrences(v_series_id, v_from, v_to);

  select array_agg(t.id order by t.session_date)
  into v_ids
  from public.training_sessions t
  where t.series_id = v_series_id;

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    v_first_session := v_ids[1];

    if v_roster = 'copy_on_create'::public.session_series_roster_policy then
      foreach v_sid in array v_ids loop
        if v_sid is distinct from v_first_session then
          perform public._copy_session_roster(v_first_session, v_sid);
        end if;
      end loop;
    end if;

    if p_athlete_ids is not null then
      foreach v_a in array p_athlete_ids loop
        if v_a is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public.coach_add_athlete(v_sid, v_a, true);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;

    if p_manual_ids is not null then
      foreach v_m in array p_manual_ids loop
        if v_m is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            insert into public.session_manual_participants (session_id, manual_participant_id)
            values (v_sid, v_m)
            on conflict (session_id, manual_participant_id) do nothing;
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'series_id', v_series_id,
    'session_ids', coalesce(v_ids, '{}'::uuid[]),
    'count', coalesce(array_length(v_ids, 1), 0)
  );
end;
$$;

-- 2) Notify all currently-registered participants when a staff member edits a
--    training session that already has registrations. Sends an in-app manager
--    message (existing manager_direct_messages inbox) plus a best-effort Expo
--    push notification, mirroring the existing waitlist push pattern.
create extension if not exists pg_net;

create or replace function public.notify_session_participants_updated(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess record;
  v_body text;
  v_notified int := 0;
  r record;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select id, session_date, start_time into v_sess
  from public.training_sessions
  where id = p_session_id;

  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  v_body := 'The details of your training session on ' || to_char(v_sess.session_date, 'YYYY-MM-DD')
    || ' at ' || to_char(v_sess.start_time, 'HH24:MI') || ' were updated by the studio. '
    || 'Please check the app for the latest details.';

  for r in
    select p.user_id, p.expo_push_token
    from public.session_registrations reg
    join public.profiles p on p.user_id = reg.user_id
    where reg.session_id = p_session_id
      and reg.status = 'active'
  loop
    begin
      insert into public.manager_direct_messages (sender_id, recipient_id, body)
      values (v_uid, r.user_id, v_body);
      v_notified := v_notified + 1;
    exception when others then
      null;
    end;

    if r.expo_push_token is not null and length(trim(r.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', r.expo_push_token,
            'title', 'Session updated',
            'body', v_body,
            'data', jsonb_build_object('session_id', p_session_id)
          )
        );
      exception when others then
        null;
      end;
    end if;
  end loop;

  return json_build_object('ok', true, 'notified', v_notified);
end;
$$;

grant execute on function public.notify_session_participants_updated(uuid) to authenticated;
