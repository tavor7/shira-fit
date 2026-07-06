-- Manager-configurable automatic birthday in-app messages (once per user per calendar year).

alter table public.app_settings
  add column if not exists birthday_messages_enabled boolean not null default false,
  add column if not exists birthday_message_body text not null default '',
  add column if not exists birthday_message_theme text not null default 'happy',
  add column if not exists birthday_message_sender_id uuid references auth.users (id) on delete set null;

alter table public.app_settings
  drop constraint if exists app_settings_birthday_message_theme_check;

alter table public.app_settings
  add constraint app_settings_birthday_message_theme_check
  check (birthday_message_theme in ('love', 'happy', 'work'));

comment on column public.app_settings.birthday_messages_enabled is
  'When true, eligible app users receive one birthday direct message per Israel calendar year.';
comment on column public.app_settings.birthday_message_body is
  'Template body; {name} is replaced with the recipient first name.';
comment on column public.app_settings.birthday_message_sender_id is
  'Manager shown as sender; set when settings are saved.';

create table if not exists public.manager_birthday_message_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  calendar_year int not null,
  message_id uuid not null references public.manager_direct_messages (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (user_id, calendar_year),
  constraint manager_birthday_message_log_year_check check (calendar_year between 2000 and 2100)
);

create index if not exists manager_birthday_message_log_message_id_idx
  on public.manager_birthday_message_log (message_id);

alter table public.manager_birthday_message_log enable row level security;

drop policy if exists manager_birthday_message_log_manager_select on public.manager_birthday_message_log;
create policy manager_birthday_message_log_manager_select on public.manager_birthday_message_log
  for select using (public.is_manager(auth.uid()));

revoke all on public.manager_birthday_message_log from authenticated;
grant select on public.manager_birthday_message_log to authenticated;

create or replace function public._birthday_message_first_name(p_full_name text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(trim(split_part(coalesce(p_full_name, ''), ' ', 1)), ''),
    'there'
  );
$$;

create or replace function public._render_birthday_message_body(p_template text, p_full_name text)
returns text
language sql
immutable
as $$
  select replace(
    coalesce(p_template, ''),
    '{name}',
    public._birthday_message_first_name(p_full_name)
  );
$$;

create or replace function public._is_birthday_on_date(p_dob date, p_on date)
returns boolean
language sql
immutable
as $$
  select
    p_dob is not null
    and p_on is not null
    and (
      (extract(month from p_dob) = extract(month from p_on) and extract(day from p_dob) = extract(day from p_on))
      or (
        extract(month from p_dob) = 2
        and extract(day from p_dob) = 29
        and extract(month from p_on) = 2
        and extract(day from p_on) = 28
        and extract(day from (date_trunc('year', p_on)::date + interval '1 month' * 2 - interval '1 day')) = 28
      )
    );
$$;

create or replace function public.get_manager_birthday_message_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.app_settings%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row from public.app_settings s where s.id = 1;

  return jsonb_build_object(
    'ok', true,
    'enabled', coalesce(v_row.birthday_messages_enabled, false),
    'body', coalesce(v_row.birthday_message_body, ''),
    'theme', coalesce(v_row.birthday_message_theme, 'happy')
  );
end;
$$;

grant execute on function public.get_manager_birthday_message_settings() to authenticated;

create or replace function public.set_manager_birthday_message_settings(
  p_enabled boolean,
  p_body text,
  p_theme text default 'happy'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_theme text := lower(trim(coalesce(p_theme, 'happy')));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_theme not in ('love', 'happy', 'work') then
    return jsonb_build_object('ok', false, 'error', 'invalid_theme');
  end if;
  if coalesce(p_enabled, false) and v_body = '' then
    return jsonb_build_object('ok', false, 'error', 'body_required');
  end if;
  if char_length(v_body) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_body');
  end if;

  update public.app_settings
  set birthday_messages_enabled = coalesce(p_enabled, false),
      birthday_message_body = v_body,
      birthday_message_theme = v_theme,
      birthday_message_sender_id = v_uid,
      updated_at = now()
  where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.set_manager_birthday_message_settings(boolean, text, text) to authenticated;

create or replace function public.send_due_birthday_messages()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.app_settings%rowtype;
  v_today date;
  v_year int;
  v_hour int;
  v_sender uuid;
  v_recipient record;
  v_body text;
  v_message_id uuid;
  v_count int := 0;
begin
  select * into v_settings from public.app_settings s where s.id = 1;
  if not coalesce(v_settings.birthday_messages_enabled, false) then
    return 0;
  end if;
  if trim(coalesce(v_settings.birthday_message_body, '')) = '' then
    return 0;
  end if;

  v_today := (timezone('Asia/Jerusalem', now()))::date;
  v_year := extract(year from v_today)::int;
  v_hour := extract(hour from timezone('Asia/Jerusalem', now()))::int;

  -- Send once each morning (Israel 08:00–08:59); cron runs hourly.
  if v_hour <> 8 then
    return 0;
  end if;

  v_sender := v_settings.birthday_message_sender_id;
  if v_sender is null or not public.is_manager(v_sender) then
    select p.user_id into v_sender
    from public.profiles p
    where p.role = 'manager'
    order by p.full_name asc nulls last
    limit 1;
  end if;
  if v_sender is null then
    return 0;
  end if;

  for v_recipient in
    select
      p.user_id,
      p.full_name
    from public.profiles p
    where p.date_of_birth is not null
      and p.role in ('athlete', 'coach', 'manager')
      and p.disabled_at is null
      and (p.role <> 'athlete' or p.approval_status = 'approved')
      and p.user_id <> v_sender
      and public._is_birthday_on_date(p.date_of_birth, v_today)
      and not exists (
        select 1
        from public.manager_birthday_message_log l
        where l.user_id = p.user_id
          and l.calendar_year = v_year
      )
  loop
    v_body := trim(public._render_birthday_message_body(v_settings.birthday_message_body, v_recipient.full_name));
    if v_body = '' or char_length(v_body) > 2000 then
      continue;
    end if;

    insert into public.manager_direct_messages (sender_id, recipient_id, body, message_theme)
    values (v_sender, v_recipient.user_id, v_body, v_settings.birthday_message_theme)
    returning id into v_message_id;

    insert into public.manager_birthday_message_log (user_id, calendar_year, message_id)
    values (v_recipient.user_id, v_year, v_message_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.send_due_birthday_messages() is
  'Idempotent daily birthday sends (Israel 08:xx). One message per user per calendar year.';

create or replace function public.schedule_birthday_message_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id int;
begin
  select j.jobid into v_job_id
  from cron.job j
  where j.jobname = 'birthday-direct-messages'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'birthday-direct-messages',
    '0 * * * *',
    $job$select public.send_due_birthday_messages();$job$
  );
end;
$$;

select public.schedule_birthday_message_cron();
