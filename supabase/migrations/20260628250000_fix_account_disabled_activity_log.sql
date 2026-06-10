-- Fix staff_set_account_disabled: _insert_activity_event expects 5 args (actor, type, target_type, target_id, metadata).

create or replace function public.staff_set_account_disabled(p_user_id uuid, p_disabled boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
  v_fn text;
  v_un text;
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

  select p.full_name, p.username into v_fn, v_un from public.profiles p where p.user_id = p_user_id;

  if coalesce(p_disabled, false) then
    if v_target.disabled_at is not null then
      return json_build_object('ok', true);
    end if;
    update public.profiles
    set disabled_at = now(), disabled_by = v_uid
    where user_id = p_user_id;

    perform public._insert_activity_event(
      v_uid,
      'account_disabled',
      'profile',
      p_user_id::text,
      jsonb_build_object(
        'target_user_id', p_user_id::text,
        'target_full_name', coalesce(v_fn, ''),
        'target_username', coalesce(v_un, '')
      )
    );
  else
    if v_target.disabled_at is null then
      return json_build_object('ok', true);
    end if;
    update public.profiles
    set disabled_at = null, disabled_by = null
    where user_id = p_user_id;

    perform public._insert_activity_event(
      v_uid,
      'account_enabled',
      'profile',
      p_user_id::text,
      jsonb_build_object(
        'target_user_id', p_user_id::text,
        'target_full_name', coalesce(v_fn, ''),
        'target_username', coalesce(v_un, '')
      )
    );
  end if;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.staff_set_account_disabled(uuid, boolean) to authenticated;
