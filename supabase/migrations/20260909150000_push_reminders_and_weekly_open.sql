-- Three new push notifications (Expo native + Web Push), alongside the existing WhatsApp
-- outbox and the existing waitlist/session-updated push paths:
--   1. Weekly registration opened (hooks the same "sessions actually flipped open" event
--      that already triggers the WhatsApp broadcast in open_next_week_sessions_if_due_core).
--   2. Day-before reminder, fixed 20:00 studio-local time.
--   3. Hour-before reminder.
--
-- These follow the direct net.http_post / invoke_send_web_push_edge style already used by
-- notify_session_participants_updated, not the WhatsApp notification_deliveries outbox —
-- that table is gated behind whatsapp_rollout_mode and channel-constrained to 'whatsapp',
-- which doesn't fit push (push should work independently of WhatsApp rollout state).

-- ---------------------------------------------------------------------------
-- Dedup table for the two time-window-based cron reminders (weekly-open reuses the
-- existing "sessions actually flipped from closed to open" guard, so needs none).
-- ---------------------------------------------------------------------------

create table if not exists public.push_reminder_dispatched (
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  reminder_type text not null,
  dispatched_at timestamptz not null default now(),
  primary key (session_id, user_id, reminder_type)
);

comment on table public.push_reminder_dispatched is
  'Claims one push send per (session, user, reminder_type) so the 15-minute cron never double-sends a reminder it already caught on an earlier tick.';

alter table public.push_reminder_dispatched enable row level security;

create policy "push_reminder_dispatched manager select"
  on public.push_reminder_dispatched for select
  to authenticated
  using (public.is_manager(auth.uid()));

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
  if p_week_start is null then
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

comment on function public.notify_weekly_registration_open_push(date, date) is
  'Push (Expo + Web) broadcast to every approved athlete when a week''s sessions actually open. Called from open_next_week_sessions_if_due_core alongside the existing WhatsApp broadcast.';

-- Re-create with the added push hook, same "only when sessions actually flipped open"
-- guard (v_n > 0) that already gates the WhatsApp broadcast.
create or replace function public.open_next_week_sessions_if_due_core()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_today date := public._studio_today_date();
  v_this_week_start date := public._week_start_sunday(v_today);
  v_open_weekday int;
  v_open_time time;
  v_open_at timestamptz;
  v_target_week_start date;
  v_target_week_end date;
  v_n int;
begin
  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := least(6, greatest(0, coalesce(v_open_weekday, 4)));
  v_open_time := coalesce(v_open_time, time '08:00');

  v_open_at := public._registration_open_at(v_this_week_start, v_open_weekday, v_open_time);

  if v_now < v_open_at then
    return json_build_object(
      'ok', true,
      'opened', 0,
      'due', false,
      'open_at', to_char(v_open_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'timezone', 'Asia/Jerusalem'
    );
  end if;

  v_target_week_start := v_this_week_start + 7;
  v_target_week_end := v_target_week_start + 6;

  update public.training_sessions s
  set is_open_for_registration = true
  where s.session_date between v_target_week_start and v_target_week_end
    and coalesce(s.is_hidden, false) = false
    and coalesce(s.is_open_for_registration, false) = false;

  get diagnostics v_n = row_count;

  if v_n > 0 then
    begin
      perform public.enqueue_weekly_registration_open_whatsapp(v_target_week_start, v_target_week_end);
    exception when others then
      null;
    end;

    begin
      perform public.notify_weekly_registration_open_push(v_target_week_start, v_target_week_end);
    exception when others then
      null;
    end;
  end if;

  return json_build_object(
    'ok', true,
    'due', true,
    'opened', v_n,
    'week_start', v_target_week_start::text,
    'week_end', v_target_week_end::text,
    'open_at', to_char(v_open_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'timezone', 'Asia/Jerusalem'
  );
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
  -- Day-before, fixed 20:00 studio-local time. Cron runs every 15 min, so a [20:00, 20:15)
  -- window guarantees exactly one tick lands in it.
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

  -- Hour-before: a 20-minute-wide window comfortably wider than the 15-min cron cadence,
  -- deduped by push_reminder_dispatched regardless of how many ticks land inside it.
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

comment on function public.dispatch_due_session_push_reminders() is
  'Push (Expo + Web) reminders: fixed 20:00 studio-local time the day before, and ~1 hour before session start. Run every 15 minutes via pg_cron.';

-- Both are meant to run only via pg_cron / internal `perform` calls, never over PostgREST —
-- otherwise any authenticated/anonymous client could trigger a mass push broadcast or spam
-- the reminder dispatcher on demand.
revoke execute on function public.notify_weekly_registration_open_push(date, date) from public, anon, authenticated;
revoke execute on function public.dispatch_due_session_push_reminders() from public, anon, authenticated;

do $$
declare
  v_job_id int;
begin
  select j.jobid into v_job_id from cron.job j where j.jobname = 'push-session-reminders' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'push-session-reminders',
    '*/15 * * * *',
    $job$select public.dispatch_due_session_push_reminders();$job$
  );
end;
$$;
