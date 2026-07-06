-- Birthday messages always appear from Shira (studio owner), not whoever saved settings.

create or replace function public._birthday_message_sender_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id
  from public.profiles p
  where p.role = 'manager'
    and p.disabled_at is null
    and (
      lower(trim(split_part(coalesce(p.full_name, ''), ' ', 1))) = 'shira'
      or trim(split_part(coalesce(p.full_name, ''), ' ', 1)) = 'שירה'
    )
  order by p.full_name asc
  limit 1;
$$;

comment on function public._birthday_message_sender_id() is
  'Manager account used as sender for automatic birthday direct messages (Shira).';

comment on column public.app_settings.birthday_message_sender_id is
  'Cached Shira manager user_id for birthday sends; refreshed when settings are saved.';

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
  v_sender uuid;
  v_sender_name text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row from public.app_settings s where s.id = 1;
  v_sender := public._birthday_message_sender_id();
  select trim(p.full_name) into v_sender_name
  from public.profiles p
  where p.user_id = v_sender;

  return jsonb_build_object(
    'ok', true,
    'enabled', coalesce(v_row.birthday_messages_enabled, false),
    'body', coalesce(v_row.birthday_message_body, ''),
    'theme', coalesce(v_row.birthday_message_theme, 'happy'),
    'sender_name', coalesce(nullif(v_sender_name, ''), 'Shira')
  );
end;
$$;

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
  v_sender uuid := public._birthday_message_sender_id();
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
      birthday_message_sender_id = v_sender,
      updated_at = now()
  where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;

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

  if v_hour <> 8 then
    return 0;
  end if;

  v_sender := coalesce(public._birthday_message_sender_id(), v_settings.birthday_message_sender_id);
  if v_sender is null or not public.is_manager(v_sender) then
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

-- Point cached sender at Shira for existing installs.
update public.app_settings
set birthday_message_sender_id = public._birthday_message_sender_id()
where id = 1;
