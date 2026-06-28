-- Manager → user in-app direct messages (shown on recipient app load until dismissed).

create table if not exists public.manager_direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint manager_direct_messages_body_len check (
    char_length(trim(body)) > 0 and char_length(body) <= 2000
  ),
  constraint manager_direct_messages_no_self check (sender_id <> recipient_id)
);

create index if not exists manager_direct_messages_recipient_unread_idx
  on public.manager_direct_messages (recipient_id, created_at)
  where read_at is null;

create index if not exists manager_direct_messages_sender_created_idx
  on public.manager_direct_messages (sender_id, created_at desc);

alter table public.manager_direct_messages enable row level security;

drop policy if exists manager_direct_messages_sender_select on public.manager_direct_messages;
create policy manager_direct_messages_sender_select on public.manager_direct_messages
  for select using (
    sender_id = auth.uid() and public.is_manager(auth.uid())
  );

drop policy if exists manager_direct_messages_sender_insert on public.manager_direct_messages;
create policy manager_direct_messages_sender_insert on public.manager_direct_messages
  for insert with check (
    sender_id = auth.uid() and public.is_manager(auth.uid())
  );

drop policy if exists manager_direct_messages_recipient_select on public.manager_direct_messages;
create policy manager_direct_messages_recipient_select on public.manager_direct_messages
  for select using (recipient_id = auth.uid());

-- Managers send; recipients read via RPC only.
revoke update, delete on public.manager_direct_messages from authenticated;
grant select, insert on public.manager_direct_messages to authenticated;

create or replace function public.send_manager_direct_message(
  p_recipient_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
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
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_recipient_id
      and p.role in ('athlete', 'coach')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;

  insert into public.manager_direct_messages (sender_id, recipient_id, body)
  values (v_uid, p_recipient_id, v_body)
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
      'created_at', to_char(v_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'sender_name', coalesce(v_row.sender_name, '')
    )
  );
end;
$$;

create or replace function public.mark_manager_direct_message_read(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;

  update public.manager_direct_messages m
  set read_at = now()
  where m.id = p_message_id
    and m.recipient_id = v_uid
    and m.read_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.send_manager_direct_message(uuid, text) to authenticated;
grant execute on function public.get_pending_manager_direct_message() to authenticated;
grant execute on function public.mark_manager_direct_message_read(uuid) to authenticated;

comment on table public.manager_direct_messages is
  'One-way in-app messages from managers to athletes/coaches; shown until recipient dismisses.';
