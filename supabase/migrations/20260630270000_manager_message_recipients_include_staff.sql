-- Allow manager direct messages to all app users (athletes, coaches, managers).

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

  return jsonb_build_object('ok', true, 'id', v_id::text);
end;
$$;

grant execute on function public.send_manager_direct_message(uuid, text, text) to authenticated;
