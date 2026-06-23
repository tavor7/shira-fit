-- WhatsApp: 3h session reminders + weekly registration open broadcast.

create or replace function public.enqueue_due_session_reminder_whatsapp()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count int := 0;
  v_dedupe text;
  v_id uuid;
begin
  if public._whatsapp_rollout_mode() = 'off' then
    return 0;
  end if;

  for v_row in
    select r.user_id, s.id as session_id, s.session_date, s.start_time
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '23 hours' and now() + interval '25 hours'
  loop
    v_dedupe := 'session_reminder_24h:' || v_row.session_id::text || ':' || v_row.user_id::text;

    v_id := public.enqueue_whatsapp_notification(
      v_row.user_id,
      'session_reminder_24h',
      v_dedupe,
      jsonb_build_object(
        'session_id', v_row.session_id,
        'session_date', v_row.session_date,
        'start_time', to_char(v_row.start_time, 'HH24:MI'),
        'template', 'session_reminder_24h'
      )
    );

    if v_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  for v_row in
    select r.user_id, s.id as session_id, s.session_date, s.start_time
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '2 hours 45 minutes' and now() + interval '3 hours 15 minutes'
  loop
    v_dedupe := 'session_reminder_3h:' || v_row.session_id::text || ':' || v_row.user_id::text;

    v_id := public.enqueue_whatsapp_notification(
      v_row.user_id,
      'session_reminder_3h',
      v_dedupe,
      jsonb_build_object(
        'session_id', v_row.session_id,
        'session_date', v_row.session_date,
        'start_time', to_char(v_row.start_time, 'HH24:MI'),
        'template', 'session_reminder_3h'
      )
    );

    if v_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count > 0 then
    perform public.invoke_dispatch_notifications_edge();
  end if;

  return v_count;
end;
$$;

create or replace function public.enqueue_weekly_registration_open_whatsapp(
  p_week_start date,
  p_week_end date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := public._whatsapp_rollout_mode();
  v_week_label text;
  v_row record;
  v_count int := 0;
  v_dedupe text;
  v_id uuid;
begin
  if v_mode = 'off' or p_week_start is null then
    return 0;
  end if;

  v_dedupe := 'weekly_open:' || p_week_start::text;
  if exists (
    select 1
    from public.notification_deliveries d
    where d.notification_type = 'weekly_registration_open'
      and d.dedupe_key = v_dedupe
      and d.status in ('pending', 'sent')
    limit 1
  ) then
    return 0;
  end if;

  v_week_label := to_char(p_week_start, 'DD/MM') || '–' || to_char(p_week_end, 'DD/MM');

  for v_row in
    select p.user_id
    from public.profiles p
    where p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
      and (
        v_mode = 'live'
        or exists (
          select 1 from public.whatsapp_test_users t where t.user_id = p.user_id
        )
      )
  loop
    v_id := public.enqueue_whatsapp_notification(
      v_row.user_id,
      'weekly_registration_open',
      v_dedupe || ':' || v_row.user_id::text,
      jsonb_build_object(
        'week_start', p_week_start,
        'week_end', p_week_end,
        'week_label', v_week_label,
        'template', 'weekly_registration_open'
      )
    );

    if v_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count > 0 then
    perform public.invoke_dispatch_notifications_edge();
  end if;

  return v_count;
end;
$$;

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
