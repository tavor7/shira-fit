-- WhatsApp notifications: outbox, manager rollout, opt-in, waitlist + session reminder hooks.
-- Default rollout_mode = 'off' — no user-visible change until a manager enables testing/live.
--
-- After deploy, set Edge secrets: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID (optional until live).
-- Vault (same CRON_SECRET as other crons):
--   select vault.create_secret('https://YOUR_REF.supabase.co/functions/v1/dispatch-notifications', 'dispatch_notifications_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'dispatch_notifications_secret');

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

create type public.notification_delivery_status as enum (
  'pending',
  'sent',
  'failed',
  'skipped'
);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  notification_type text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.notification_delivery_status not null default 'pending',
  skip_reason text,
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (channel, user_id, notification_type, dedupe_key)
);

create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (created_at)
  where status = 'pending';

alter table public.profiles
  add column if not exists whatsapp_notifications_enabled boolean not null default false,
  add column if not exists whatsapp_opted_in_at timestamptz,
  add column if not exists whatsapp_phone_e164 text;

alter table public.app_settings
  add column if not exists whatsapp_rollout_mode text not null default 'off';

alter table public.app_settings
  drop constraint if exists app_settings_whatsapp_rollout_mode_check;

alter table public.app_settings
  add constraint app_settings_whatsapp_rollout_mode_check
  check (whatsapp_rollout_mode in ('off', 'testing', 'live'));

create table if not exists public.whatsapp_test_users (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (user_id) on delete set null
);

alter table public.notification_deliveries enable row level security;
alter table public.whatsapp_test_users enable row level security;

drop policy if exists notification_deliveries_manager_select on public.notification_deliveries;
create policy notification_deliveries_manager_select on public.notification_deliveries
for select using (public.is_manager(auth.uid()));

drop policy if exists whatsapp_test_users_manager_select on public.whatsapp_test_users;
create policy whatsapp_test_users_manager_select on public.whatsapp_test_users
for select using (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- Phone + rollout helpers
-- ---------------------------------------------------------------------------

create or replace function public.normalize_phone_e164(p_phone text, p_default_country text default '972')
returns text
language plpgsql
immutable
as $$
declare
  v_digits text;
  v_cc text := regexp_replace(coalesce(p_default_country, '972'), '\D', '', 'g');
begin
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_digits) < 9 then
    return null;
  end if;
  if v_digits like v_cc || '%' and length(v_digits) >= length(v_cc) + 8 then
    return '+' || v_digits;
  end if;
  if v_digits ~ '^0' then
    v_digits := v_cc || substring(v_digits from 2);
  elsif length(v_digits) = 9 or length(v_digits) = 10 then
    v_digits := v_cc || v_digits;
  end if;
  if length(v_digits) < 11 or length(v_digits) > 15 then
    return null;
  end if;
  return '+' || v_digits;
end;
$$;

create or replace function public._whatsapp_rollout_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.whatsapp_rollout_mode from public.app_settings s where s.id = 1),
    'off'
  );
$$;

create or replace function public._whatsapp_user_in_test_list(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.whatsapp_test_users t where t.user_id = p_user_id
  );
$$;

create or replace function public._whatsapp_user_can_see_settings(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case public._whatsapp_rollout_mode()
    when 'live' then true
    when 'testing' then public._whatsapp_user_in_test_list(p_user_id)
    else false
  end;
$$;

create or replace function public._whatsapp_user_can_receive(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public._whatsapp_user_can_see_settings(p_user_id)
    and exists (
      select 1
      from public.profiles p
      where p.user_id = p_user_id
        and p.whatsapp_notifications_enabled = true
        and p.whatsapp_phone_e164 is not null
        and length(trim(p.whatsapp_phone_e164)) >= 10
    );
$$;

create or replace function public._session_start_at_studio(p_session_date date, p_start_time time)
returns timestamptz
language sql
stable
as $$
  select ((p_session_date + p_start_time)::timestamp at time zone 'Asia/Jerusalem');
$$;

-- ---------------------------------------------------------------------------
-- Enqueue + dispatch invoke
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_whatsapp_notification(
  p_user_id uuid,
  p_notification_type text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := public._whatsapp_rollout_mode();
  v_id uuid;
begin
  if p_user_id is null or p_notification_type is null or p_dedupe_key is null then
    return null;
  end if;

  if v_mode = 'off' then
    return null;
  end if;

  if v_mode = 'testing' and not public._whatsapp_user_in_test_list(p_user_id) then
    return null;
  end if;

  if not public._whatsapp_user_can_receive(p_user_id) then
    insert into public.notification_deliveries (
      channel, user_id, notification_type, dedupe_key, payload, status, skip_reason
    )
    values (
      'whatsapp', p_user_id, p_notification_type, p_dedupe_key, coalesce(p_payload, '{}'::jsonb),
      'skipped', 'user_not_eligible'
    )
    on conflict (channel, user_id, notification_type, dedupe_key) do nothing
    returning id into v_id;
    return v_id;
  end if;

  insert into public.notification_deliveries (
    channel, user_id, notification_type, dedupe_key, payload, status
  )
  values (
    'whatsapp', p_user_id, p_notification_type, p_dedupe_key, coalesce(p_payload, '{}'::jsonb), 'pending'
  )
  on conflict (channel, user_id, notification_type, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.invoke_dispatch_notifications_edge()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if public._whatsapp_rollout_mode() = 'off' then
    return;
  end if;

  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds
  where ds.name = 'dispatch_notifications_url'
  limit 1;

  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'dispatch_notifications_secret'
  limit 1;

  if v_url is null or v_secret is null
     or length(trim(v_url)) < 10
     or length(trim(v_secret)) < 4
  then
    return;
  end if;

  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(v_secret)
    ),
    body := jsonb_build_object('limit', 50)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Waitlist WhatsApp (parallel to existing Expo push — push path unchanged)
-- ---------------------------------------------------------------------------

create or replace function public.maybe_enqueue_whatsapp_waitlist(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess record;
  v_filled int;
  v_first record;
  v_dedupe text;
  v_delivery_id uuid;
begin
  if p_session_id is null or public._whatsapp_rollout_mode() = 'off' then
    return;
  end if;

  select s.id, s.max_participants, s.session_date, s.start_time
  into v_sess
  from public.training_sessions s
  where s.id = p_session_id;

  if not found then
    return;
  end if;

  select count(*)::int into v_filled
  from (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.status = 'active'
    union all
    select 1 from public.session_manual_participants m
    where m.session_id = p_session_id
  ) x;

  if v_filled >= v_sess.max_participants then
    return;
  end if;

  select w.user_id into v_first
  from public.waitlist_requests w
  where w.session_id = p_session_id
  order by w.requested_at asc
  limit 1;

  if v_first.user_id is null then
    return;
  end if;

  v_dedupe := 'waitlist:' || p_session_id::text || ':' || v_first.user_id::text || ':'
    || to_char(now() at time zone 'Asia/Jerusalem', 'YYYYMMDDHH24MI');

  v_delivery_id := public.enqueue_whatsapp_notification(
    v_first.user_id,
    'waitlist_spot',
    v_dedupe,
    jsonb_build_object(
      'session_id', p_session_id,
      'session_date', v_sess.session_date,
      'start_time', to_char(v_sess.start_time, 'HH24:MI'),
      'template', 'waitlist_spot'
    )
  );

  if v_delivery_id is not null then
    perform public.invoke_dispatch_notifications_edge();
  end if;
end;
$$;

create or replace function public.tg_notify_waitlist_session_registration_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoke_notify_waitlist_edge(new.session_id);
  begin
    perform public.maybe_enqueue_whatsapp_waitlist(new.session_id);
  exception when others then
    null;
  end;
  return new;
end;
$$;

create or replace function public.tg_notify_waitlist_manual_participant_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoke_notify_waitlist_edge(old.session_id);
  begin
    perform public.maybe_enqueue_whatsapp_waitlist(old.session_id);
  exception when others then
    null;
  end;
  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- Session reminder cron (24h before, studio timezone)
-- ---------------------------------------------------------------------------

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

  if v_count > 0 then
    perform public.invoke_dispatch_notifications_edge();
  end if;

  return v_count;
end;
$$;

create or replace function public.schedule_whatsapp_notification_crons()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id int;
begin
  select j.jobid into v_job_id from cron.job j where j.jobname = 'whatsapp-session-reminders' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'whatsapp-session-reminders',
    '*/30 * * * *',
    $job$select public.enqueue_due_session_reminder_whatsapp();$job$
  );

  select j.jobid into v_job_id from cron.job j where j.jobname = 'whatsapp-dispatch-notifications' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'whatsapp-dispatch-notifications',
    '*/5 * * * *',
    $job$select public.invoke_dispatch_notifications_edge();$job$
  );
end;
$$;

select public.schedule_whatsapp_notification_crons();

-- ---------------------------------------------------------------------------
-- User + manager RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_whatsapp_feature_state()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_can_see boolean;
  v_can_receive boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  v_can_see := public._whatsapp_user_can_see_settings(v_uid);
  v_can_receive := public._whatsapp_user_can_receive(v_uid);

  return json_build_object(
    'ok', true,
    'rollout_mode', public._whatsapp_rollout_mode(),
    'can_see_settings', v_can_see,
    'can_receive', v_can_receive,
    'whatsapp_enabled', (
      select p.whatsapp_notifications_enabled from public.profiles p where p.user_id = v_uid
    ),
    'whatsapp_phone_e164', (
      select p.whatsapp_phone_e164 from public.profiles p where p.user_id = v_uid
    )
  );
end;
$$;

grant execute on function public.get_whatsapp_feature_state() to authenticated;

create or replace function public.set_whatsapp_notifications_enabled(p_enabled boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_phone text;
  v_e164 text;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not public._whatsapp_user_can_see_settings(v_uid) then
    return json_build_object('ok', false, 'error', 'feature_not_available');
  end if;

  if coalesce(p_enabled, false) then
    select p.phone into v_phone from public.profiles p where p.user_id = v_uid;
    v_e164 := public.normalize_phone_e164(v_phone);
    if v_e164 is null then
      return json_build_object('ok', false, 'error', 'invalid_phone');
    end if;

    update public.profiles
    set whatsapp_notifications_enabled = true,
        whatsapp_opted_in_at = coalesce(whatsapp_opted_in_at, now()),
        whatsapp_phone_e164 = v_e164
    where user_id = v_uid;
  else
    update public.profiles
    set whatsapp_notifications_enabled = false
    where user_id = v_uid;
  end if;

  return json_build_object('ok', true, 'enabled', coalesce(p_enabled, false));
end;
$$;

grant execute on function public.set_whatsapp_notifications_enabled(boolean) to authenticated;

create or replace function public.get_whatsapp_rollout_config()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_users json;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select coalesce(json_agg(
    json_build_object(
      'user_id', p.user_id,
      'full_name', p.full_name,
      'phone', p.phone,
      'role', p.role
    ) order by p.full_name
  ), '[]'::json)
  into v_users
  from public.whatsapp_test_users t
  join public.profiles p on p.user_id = t.user_id;

  return json_build_object(
    'ok', true,
    'mode', public._whatsapp_rollout_mode(),
    'test_users', v_users
  );
end;
$$;

grant execute on function public.get_whatsapp_rollout_config() to authenticated;

create or replace function public.set_whatsapp_rollout_mode(p_mode text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text := lower(trim(coalesce(p_mode, '')));
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_mode not in ('off', 'testing', 'live') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  update public.app_settings
  set whatsapp_rollout_mode = v_mode,
      updated_at = now()
  where id = 1;

  return json_build_object('ok', true, 'mode', v_mode);
end;
$$;

grant execute on function public.set_whatsapp_rollout_mode(text) to authenticated;

create or replace function public.set_whatsapp_test_users(p_user_ids uuid[])
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_ids := array(
    select distinct unnest(coalesce(p_user_ids, array[]::uuid[]))
  );

  delete from public.whatsapp_test_users;

  if array_length(v_ids, 1) is not null then
    insert into public.whatsapp_test_users (user_id, added_by)
    select x.uid, v_uid
    from unnest(v_ids) as x(uid)
    where exists (select 1 from public.profiles p where p.user_id = x.uid);
  end if;

  return json_build_object('ok', true, 'count', coalesce(array_length(v_ids, 1), 0));
end;
$$;

grant execute on function public.set_whatsapp_test_users(uuid[]) to authenticated;

create or replace function public.search_whatsapp_test_user_candidates(p_term text default '', p_limit int default 40)
returns table (
  user_id uuid,
  full_name text,
  phone text,
  role public.user_role,
  username text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_safe text;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  v_safe := trim(coalesce(p_term, ''));
  return query
  select p.user_id, p.full_name, p.phone, p.role, p.username
  from public.profiles p
  where p.role in ('athlete', 'coach', 'manager')
    and (
      v_safe = ''
      or p.full_name ilike '%' || v_safe || '%'
      or p.username ilike '%' || v_safe || '%'
      or p.phone ilike '%' || v_safe || '%'
    )
  order by p.full_name
  limit greatest(1, least(coalesce(p_limit, 40), 80));
end;
$$;

grant execute on function public.search_whatsapp_test_user_candidates(text, int) to authenticated;
