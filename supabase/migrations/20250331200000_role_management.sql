-- Manager-only role management (promote/demote).
-- Allows managers to set a user's role to athlete/coach/manager.

create or replace function public.set_user_role(
  p_user_id uuid,
  p_role public.user_role
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_exists boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select exists(select 1 from public.profiles p where p.user_id = p_user_id) into v_exists;
  if not v_exists then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  update public.profiles
  set role = p_role
  where user_id = p_user_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_user_role(uuid, public.user_role) to authenticated;

