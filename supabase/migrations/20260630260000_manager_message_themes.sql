-- Message themes: love, happy, work.

alter table public.manager_direct_messages
  add column if not exists message_theme text not null default 'love';

alter table public.manager_direct_messages
  drop constraint if exists manager_direct_messages_theme_check;

alter table public.manager_direct_messages
  add constraint manager_direct_messages_theme_check
  check (message_theme in ('love', 'happy', 'work'));

drop function if exists public.send_manager_direct_message(uuid, text);

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
      and p.role in ('athlete', 'coach')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;

  insert into public.manager_direct_messages (sender_id, recipient_id, body, message_theme)
  values (v_uid, p_recipient_id, v_body, v_theme)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id::text);
end;
$$;

create or replace function public.get_pending_manager_direct_message()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select
    m.id,
    m.body,
    m.message_theme,
    m.created_at,
    s.full_name as sender_name
  into v_row
  from public.manager_direct_messages m
  join public.profiles s on s.user_id = m.sender_id
  where m.recipient_id = v_uid
    and m.read_at is null
  order by m.created_at asc
  limit 1;

  if not found then
    return jsonb_build_object('ok', true, 'message', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', jsonb_build_object(
      'id', v_row.id::text,
      'body', v_row.body,
      'message_theme', coalesce(v_row.message_theme, 'love'),
      'created_at', to_char(v_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'sender_name', coalesce(v_row.sender_name, '')
    )
  );
end;
$$;

grant execute on function public.send_manager_direct_message(uuid, text, text) to authenticated;
