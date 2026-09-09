-- All system-generated push notifications (and the manager test/custom tools) now:
--   1. Always use "Shira Fit" as the push title — no per-type descriptive title, the
--      specific message is the body text.
--   2. Are written in Hebrew (this studio's actual user base), not English.
-- The custom broadcast also drops its separate title field/param entirely, since the
-- title is now fixed — a manager writing a custom message doesn't need to think about it.

-- ---------------------------------------------------------------------------
-- 1. Weekly registration opened
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
  v_body := 'ההרשמה לשבוע ' || v_week_label || ' נפתחה! היכנסו לאפליקציה כדי להירשם לאימונים.';

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
            'title', 'Shira Fit',
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
        'Shira Fit',
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

-- ---------------------------------------------------------------------------
-- 2 + 3. Day-before-at-20:00 and hour-before session reminders
-- ---------------------------------------------------------------------------

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

      v_body := 'תזכורת: האימון שלך מחר בשעה ' || to_char(v_row.start_time, 'HH24:MI') || '. מצפים לראותך!';

      if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
        begin
          perform net.http_post(
            url := 'https://exp.host/--/api/v2/push/send',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object(
              'to', v_row.expo_push_token,
              'title', 'Shira Fit',
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
          'Shira Fit',
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

    v_body := 'האימון שלך מתחיל בעוד כשעה, בשעה ' || to_char(v_row.start_time, 'HH24:MI') || '.';

    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', v_row.expo_push_token,
            'title', 'Shira Fit',
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
        'Shira Fit',
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

-- ---------------------------------------------------------------------------
-- 4. Session updated
-- ---------------------------------------------------------------------------

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

  v_body := 'פרטי האימון שלך בתאריך ' || to_char(v_sess.session_date, 'YYYY-MM-DD')
    || ' בשעה ' || to_char(v_sess.start_time, 'HH24:MI') || ' עודכנו על ידי הסטודיו. '
    || 'בדקו את האפליקציה לפרטים המלאים.';

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
              'title', 'Shira Fit',
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
          'Shira Fit',
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
-- 5. Manager test send — same Hebrew bodies, title "Shira Fit", keeps a [בדיקה] marker
-- ---------------------------------------------------------------------------

create or replace function public.send_test_push_notification(p_type text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := 'Shira Fit';
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
      v_body := '[בדיקה] ההרשמה לשבוע 01/01–07/01 נפתחה! היכנסו לאפליקציה כדי להירשם לאימונים.';
    when 'day_before' then
      v_body := '[בדיקה] תזכורת: האימון שלך מחר בשעה 18:00. מצפים לראותך!';
    when 'hour_before' then
      v_body := '[בדיקה] האימון שלך מתחיל בעוד כשעה, בשעה 18:00.';
    when 'waitlist_spot' then
      v_body := '[בדיקה] התפנה מקום לאימון בתאריך 2026-01-01 בשעה 18:00. היכנסו לאפליקציה כדי להירשם.';
    when 'session_updated' then
      v_body := '[בדיקה] פרטי האימון שלך בתאריך 2026-01-01 בשעה 18:00 עודכנו על ידי הסטודיו. בדקו את האפליקציה לפרטים.';
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

-- ---------------------------------------------------------------------------
-- 6. Custom broadcast — drop the separate title param/field; title is always "Shira Fit"
-- ---------------------------------------------------------------------------

drop function if exists public.send_custom_push_notification(text, text);

create or replace function public.send_custom_push_notification(p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := 'Shira Fit';
  v_body text := trim(coalesce(p_body, ''));
  v_row record;
  v_count int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_body = '' then
    return json_build_object('ok', false, 'error', 'body_required');
  end if;
  if not public._push_notifications_enabled() then
    return json_build_object('ok', false, 'error', 'push_disabled');
  end if;

  for v_row in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.disabled_at is null
      and (p.role != 'athlete' or p.approval_status = 'approved')
  loop
    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('to', v_row.expo_push_token, 'title', v_title, 'body', v_body)
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(v_row.user_id, v_title, v_body, '{}'::jsonb);
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return json_build_object('ok', true, 'notified', v_count);
end;
$$;

comment on function public.send_custom_push_notification(text) is
  'Manager broadcast: sends a manager-written message, always titled "Shira Fit", (Expo + Web) to every non-disabled user. Respects the kill switch.';

grant execute on function public.send_custom_push_notification(text) to authenticated;
