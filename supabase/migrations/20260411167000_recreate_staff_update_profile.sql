-- Ensure staff_update_profile exists with the expected signature.
-- Some environments may end up with a missing/partial migration, causing:
--   function public.staff_update_profile(uuid, text, text, text, date) does not exist

create or replace function public.staff_update_profile(
  p_user_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'user_not_found'); end if;

  if v_target.role = 'manager' then
    return json_build_object('ok', false, 'error', 'cannot_edit_manager');
  end if;

  if not public.is_manager(v_uid) then
    -- coaches can only edit athletes
    if v_target.role <> 'athlete' then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  update public.profiles
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    gender = coalesce(nullif(trim(p_gender), ''), gender),
    date_of_birth = coalesce(p_date_of_birth, date_of_birth)
  where user_id = p_user_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.staff_update_profile(uuid, text, text, text, date) to authenticated;

