-- Log more manager-initiated actions that were never recorded in
-- user_activity_events: direct messages, birthday message settings, and
-- WhatsApp rollout settings. Logic is otherwise unchanged from the live
-- versions of these functions.

create or replace function public.send_manager_direct_message(
  p_recipient_id uuid,
  p_body text,
  p_theme text default 'love'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_theme text := lower(trim(coalesce(p_theme, 'love')));
  v_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_recipient_id is null or p_recipient_id = v_uid then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;
  if v_body = '' or char_length(v_body) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if v_theme not in ('love', 'happy', 'work') then
    return jsonb_build_object('ok', false, 'error', 'invalid_theme');
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_recipient_id
      and p.role in ('athlete', 'coach', 'manager')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;

  insert into public.manager_direct_messages (sender_id, recipient_id, body, message_theme)
  values (v_uid, p_recipient_id, v_body, v_theme)
  returning id into v_id;

  perform public._insert_activity_event(
    v_uid,
    'manager_direct_message_sent',
    'manager_direct_message',
    v_id::text,
    jsonb_build_object(
      'message_id', v_id::text,
      'recipient_user_id', p_recipient_id::text,
      'theme', v_theme,
      'body_preview', left(v_body, 200)
    )
  );

  return jsonb_build_object('ok', true, 'id', v_id::text);
end;
$$;

grant execute on function public.send_manager_direct_message(uuid, text, text) to authenticated;

create or replace function public.cancel_manager_direct_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_msg public.manager_direct_messages%rowtype;
  v_n int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;

  select * into v_msg from public.manager_direct_messages where id = p_message_id;

  delete from public.manager_direct_messages m
  where m.id = p_message_id
    and m.sender_id = v_uid
    and m.read_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_already_read');
  end if;

  perform public._insert_activity_event(
    v_uid,
    'manager_direct_message_cancelled',
    'manager_direct_message',
    p_message_id::text,
    jsonb_build_object(
      'message_id', p_message_id::text,
      'recipient_user_id', v_msg.recipient_id::text,
      'body_preview', left(coalesce(v_msg.body, ''), 200)
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.cancel_manager_direct_message(uuid) to authenticated;

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

  perform public._insert_activity_event(
    v_uid,
    'birthday_message_settings_updated',
    'app_settings',
    '1',
    jsonb_build_object(
      'enabled', coalesce(p_enabled, false),
      'theme', v_theme,
      'body_preview', left(v_body, 200)
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.set_manager_birthday_message_settings(boolean, text, text) to authenticated;

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

  perform public._insert_activity_event(
    v_uid,
    'whatsapp_settings_updated',
    'app_settings',
    '1',
    jsonb_build_object('mode', v_mode)
  );

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

  delete from public.whatsapp_test_users where true;

  if array_length(v_ids, 1) is not null then
    insert into public.whatsapp_test_users (user_id, added_by)
    select x.uid, v_uid
    from unnest(v_ids) as x(uid)
    where exists (select 1 from public.profiles p where p.user_id = x.uid);
  end if;

  perform public._insert_activity_event(
    v_uid,
    'whatsapp_settings_updated',
    'app_settings',
    '1',
    jsonb_build_object('test_user_count', coalesce(array_length(v_ids, 1), 0))
  );

  return json_build_object('ok', true, 'count', coalesce(array_length(v_ids, 1), 0));
end;
$$;

grant execute on function public.set_whatsapp_test_users(uuid[]) to authenticated;

create or replace function public.save_whatsapp_rollout_config(
  p_mode text,
  p_user_ids jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text := lower(trim(coalesce(p_mode, '')));
  v_count int := 0;
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

  delete from public.whatsapp_test_users where true;

  if v_mode = 'testing' and jsonb_typeof(coalesce(p_user_ids, '[]'::jsonb)) = 'array' then
    insert into public.whatsapp_test_users (user_id, added_by)
    select x.uid::uuid, v_uid
    from jsonb_array_elements_text(coalesce(p_user_ids, '[]'::jsonb)) as x(uid)
    where exists (select 1 from public.profiles p where p.user_id = x.uid::uuid);

    get diagnostics v_count = row_count;
  end if;

  perform public._insert_activity_event(
    v_uid,
    'whatsapp_settings_updated',
    'app_settings',
    '1',
    jsonb_build_object('mode', v_mode, 'test_user_count', v_count)
  );

  return json_build_object('ok', true, 'mode', v_mode, 'count', v_count);
end;
$$;

grant execute on function public.save_whatsapp_rollout_config(text, jsonb) to authenticated;
