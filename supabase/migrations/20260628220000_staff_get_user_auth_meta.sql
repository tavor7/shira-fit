-- Staff: read auth metadata (last sign-in) for a user they may edit.

create or replace function public.staff_get_user_auth_meta(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
  v_last_sign_in timestamptz;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_target.role = 'manager' then
    return json_build_object('ok', false, 'error', 'cannot_edit_manager');
  end if;

  if not public.is_manager(v_uid) and v_target.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select u.last_sign_in_at into v_last_sign_in from auth.users u where u.id = p_user_id;

  return json_build_object(
    'ok', true,
    'user_id', p_user_id,
    'last_sign_in_at', v_last_sign_in
  );
end;
$$;

grant execute on function public.staff_get_user_auth_meta(uuid) to authenticated;

comment on function public.staff_get_user_auth_meta(uuid) is
  'Coach/manager: last sign-in timestamp for an editable user profile.';
