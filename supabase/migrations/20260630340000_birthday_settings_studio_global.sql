-- Birthday message settings are studio-wide (app_settings singleton). Track last editor for managers.

alter table public.app_settings
  add column if not exists birthday_messages_updated_by uuid references auth.users (id) on delete set null,
  add column if not exists birthday_messages_updated_at timestamptz;

comment on column public.app_settings.birthday_messages_updated_by is
  'Last manager who saved studio-wide birthday message settings.';
comment on column public.app_settings.birthday_messages_updated_at is
  'When studio-wide birthday message settings were last saved.';

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
  v_updated_by_name text;
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

  select trim(p.full_name) into v_updated_by_name
  from public.profiles p
  where p.user_id = v_row.birthday_messages_updated_by;

  return jsonb_build_object(
    'ok', true,
    'enabled', coalesce(v_row.birthday_messages_enabled, false),
    'body', coalesce(v_row.birthday_message_body, ''),
    'theme', coalesce(v_row.birthday_message_theme, 'happy'),
    'sender_name', coalesce(nullif(v_sender_name, ''), 'Shira'),
    'updated_at', case
      when v_row.birthday_messages_updated_at is null then null
      else to_char(v_row.birthday_messages_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    end,
    'updated_by_name', nullif(v_updated_by_name, '')
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
      birthday_messages_updated_by = v_uid,
      birthday_messages_updated_at = now(),
      updated_at = now()
  where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;
