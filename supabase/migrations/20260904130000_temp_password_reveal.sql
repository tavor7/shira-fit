-- Let a manager re-view a temporary password they issued, for as long as the user
-- hasn't changed it yet. The plaintext is stored but never directly selectable by
-- clients (column-level revoke) — only reachable through the manager-gated RPC below,
-- same shape as the other staff_* security definer functions.

alter table public.profiles
  add column if not exists temp_password_plaintext text;

comment on column public.profiles.temp_password_plaintext is
  'Plaintext of the most recent staff-issued temporary password. Cleared once the user sets their own password. Not directly selectable by clients — read via staff_get_temp_password().';

revoke select (temp_password_plaintext) on public.profiles from authenticated, anon;

create or replace function public.staff_get_temp_password(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pw text;
  v_must boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select temp_password_plaintext, must_change_password into v_pw, v_must
  from public.profiles where user_id = p_user_id;

  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if not coalesce(v_must, false) then
    return json_build_object('ok', true, 'password', null);
  end if;

  return json_build_object('ok', true, 'password', v_pw);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.staff_get_temp_password(uuid) to authenticated;

create or replace function public.clear_must_change_password()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  update public.profiles
  set must_change_password = false, temp_password_plaintext = null
  where user_id = v_uid;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.clear_must_change_password() to authenticated;
