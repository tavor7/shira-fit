-- Four additions to the push notification system:
--   1. push_notifications_enabled kill switch (app_settings) — when off, no push of any
--      kind (Expo or Web) reaches any user, checked at every send path.
--   2. One-time per-account onboarding prompt (profiles.notifications_onboarded_at).
--   3. Manager-only test send: pushes one sample of a given notification type to the
--      calling manager only, bypassing the kill switch (it's a diagnostic tool).
--   4. (Client-side, no DB change needed) the two prefs collapse to a single on/off in
--      the UI — the enqueue paths already only cared about token/subscription presence.

alter table public.app_settings
  add column if not exists push_notifications_enabled boolean not null default true;

alter table public.profiles
  add column if not exists notifications_onboarded_at timestamptz;

comment on column public.app_settings.push_notifications_enabled is
  'Manager kill switch. When false, no push (Expo or Web) is sent to any user, regardless of individual settings or tokens on file.';
comment on column public.profiles.notifications_onboarded_at is
  'Set once, the first time this account answers the one-time "enable notifications?" prompt on login. Null means the prompt is still due.';

create or replace function public._push_notifications_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select push_notifications_enabled from public.app_settings where id = 1), true);
$$;

-- Internal-only helper (leading underscore, matches the codebase's existing convention,
-- e.g. _whatsapp_rollout_mode) — never meant to be called directly over PostgREST.
revoke execute on function public._push_notifications_enabled() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Kill switch: gate the three SQL-side push senders. (Web push's own send path,
-- shared by send-web-push and notify-waitlist, checks the same flag itself —
-- see supabase/functions/_shared/webPush.ts.)
-- ---------------------------------------------------------------------------

create or replace function public.notify_weekly_registration_open_push(p_week_start date, p_week_end date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week_label text;
  v_body text;
  v_row record;
  v_count int := 0;
begin
  if p_week_start is null or not public._push_notifications_enabled() then
    return 0;
  end if;

  v_week_label := to_char(p_week_start, 'DD/MM') || '–' || to_char(p_week_end, 'DD/MM');
  v_body := 'Registration for ' || v_week_label || ' is now open. Open the app to book your sessions.';

  for v_row in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
  loop
    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', v_row.expo_push_token,
            'title', 'Registration open',
            'body', v_body,
            'data', jsonb_build_object('week_start', p_week_start::text)
          )
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(
        v_row.user_id,
        'Registration open',
        v_body,
        jsonb_build_object('week_start', p_week_start::text)
      );
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.dispatch_due_session_push_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public._studio_today_date();
  v_time_now time := (now() at time zone 'Asia/Jerusalem')::time;
  v_row record;
  v_count int := 0;
  v_body text;
  v_claimed boolean;
begin
  if not public._push_notifications_enabled() then
    return 0;
  end if;

  if v_time_now >= time '20:00' and v_time_now < time '20:15' then
    for v_row in
      select r.user_id, s.id as session_id, s.start_time, p.expo_push_token
      from public.session_registrations r
      join public.training_sessions s on s.id = r.session_id
      join public.profiles p on p.user_id = r.user_id
      where r.status = 'active'
        and coalesce(s.is_hidden, false) = false
        and p.role = 'athlete'
        and p.approval_status = 'approved'
        and p.disabled_at is null
        and s.session_date = v_today + 1
    loop
      v_claimed := true;
      begin
        insert into public.push_reminder_dispatched (session_id, user_id, reminder_type)
        values (v_row.session_id, v_row.user_id, 'day_before_20h');
      exception when unique_violation then
        v_claimed := false;
      end;
      if not v_claimed then
        continue;
      end if;

      v_body := 'Your session tomorrow at ' || to_char(v_row.start_time, 'HH24:MI') || ' — see you there!';

      if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
        begin
          perform net.http_post(
            url := 'https://exp.host/--/api/v2/push/send',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object(
              'to', v_row.expo_push_token,
              'title', 'Session tomorrow',
              'body', v_body,
              'data', jsonb_build_object('session_id', v_row.session_id)
            )
          );
        exception when others then
          null;
        end;
      end if;

      begin
        perform public.invoke_send_web_push_edge(
          v_row.user_id,
          'Session tomorrow',
          v_body,
          jsonb_build_object('session_id', v_row.session_id::text)
        );
      exception when others then
        null;
      end;

      v_count := v_count + 1;
    end loop;
  end if;

  for v_row in
    select r.user_id, s.id as session_id, s.start_time, p.expo_push_token
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '50 minutes' and now() + interval '70 minutes'
  loop
    v_claimed := true;
    begin
      insert into public.push_reminder_dispatched (session_id, user_id, reminder_type)
      values (v_row.session_id, v_row.user_id, 'hour_before');
    exception when unique_violation then
      v_claimed := false;
    end;
    if not v_claimed then
      continue;
    end if;

    v_body := 'Your session starts at ' || to_char(v_row.start_time, 'HH24:MI') || ' — starting in about an hour.';

    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', v_row.expo_push_token,
            'title', 'Session starting soon',
            'body', v_body,
            'data', jsonb_build_object('session_id', v_row.session_id)
          )
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(
        v_row.user_id,
        'Session starting soon',
        v_body,
        jsonb_build_object('session_id', v_row.session_id::text)
      );
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

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
  v_push_on boolean := public._push_notifications_enabled();
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

    if v_push_on then
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

      begin
        perform public.invoke_send_web_push_edge(
          r.user_id,
          'Session updated',
          v_body,
          jsonb_build_object('session_id', p_session_id::text)
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

-- ---------------------------------------------------------------------------
-- Kill switch manager settings RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_push_kill_switch()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  return json_build_object('ok', true, 'enabled', public._push_notifications_enabled());
end;
$$;

grant execute on function public.get_push_kill_switch() to authenticated;

create or replace function public.set_push_kill_switch(p_enabled boolean)
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
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.app_settings set push_notifications_enabled = coalesce(p_enabled, true) where id = 1;

  return json_build_object('ok', true, 'enabled', coalesce(p_enabled, true));
end;
$$;

grant execute on function public.set_push_kill_switch(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- One-time onboarding prompt
-- ---------------------------------------------------------------------------

create or replace function public.mark_notifications_onboarded()
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

  update public.profiles
  set notifications_onboarded_at = coalesce(notifications_onboarded_at, now())
  where user_id = v_uid;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.mark_notifications_onboarded() to authenticated;

-- ---------------------------------------------------------------------------
-- Manager test send: one sample push of a given type, to the calling manager only.
-- Deliberately bypasses the kill switch — it's the diagnostic tool for checking
-- delivery still works, including while the kill switch is off for everyone else.
-- ---------------------------------------------------------------------------

create or replace function public.send_test_push_notification(p_type text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text;
  v_body text;
  v_token text;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  case p_type
    when 'weekly_open' then
      v_title := 'Registration open';
      v_body := '[Test] Registration for 01/01–07/01 is now open. Open the app to book your sessions.';
    when 'day_before' then
      v_title := 'Session tomorrow';
      v_body := '[Test] Your session tomorrow at 18:00 — see you there!';
    when 'hour_before' then
      v_title := 'Session starting soon';
      v_body := '[Test] Your session starts at 18:00 — starting in about an hour.';
    when 'waitlist_spot' then
      v_title := 'Spot available';
      v_body := '[Test] A spot opened for 2026-01-01 18:00. Open the app to register.';
    when 'session_updated' then
      v_title := 'Session updated';
      v_body := '[Test] The details of your training session on 2026-01-01 at 18:00 were updated by the studio.';
    else
      return json_build_object('ok', false, 'error', 'invalid_type');
  end case;

  select expo_push_token into v_token from public.profiles where user_id = v_uid;

  if v_token is not null and length(trim(v_token)) > 0 then
    begin
      perform net.http_post(
        url := 'https://exp.host/--/api/v2/push/send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('to', v_token, 'title', v_title, 'body', v_body)
      );
    exception when others then
      null;
    end;
  end if;

  begin
    perform public.invoke_send_web_push_edge(v_uid, v_title, v_body, '{}'::jsonb);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'type', p_type);
end;
$$;

grant execute on function public.send_test_push_notification(text) to authenticated;
