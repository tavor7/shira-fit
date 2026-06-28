-- Managers may cancel (delete) a direct message only before the recipient reads it.

create or replace function public.cancel_manager_direct_message(p_message_id uuid)
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
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;

  delete from public.manager_direct_messages m
  where m.id = p_message_id
    and m.sender_id = v_uid
    and m.read_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_already_read');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.cancel_manager_direct_message(uuid) to authenticated;

comment on function public.cancel_manager_direct_message(uuid) is
  'Manager only. Deletes an unread message they sent; fails if already read.';
