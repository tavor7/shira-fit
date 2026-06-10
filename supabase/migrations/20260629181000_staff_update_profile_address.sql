-- Allow staff to view/edit athlete address + zip on profile edit.

create or replace function public.staff_update_profile(
  p_user_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_address text default null,
  p_zip_code text default null
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
    if v_target.role <> 'athlete' then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  update public.profiles
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    gender = coalesce(nullif(trim(p_gender), ''), gender),
    date_of_birth = coalesce(p_date_of_birth, date_of_birth),
    address = case when p_address is not null then trim(p_address) else address end,
    zip_code = case when p_zip_code is not null then trim(p_zip_code) else zip_code end
  where user_id = p_user_id;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.staff_update_profile_text(
  p_user_id text,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth text default null,
  p_address text default null,
  p_zip_code text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_dob date;
  v_uid_raw text;
  v_dob_raw text;
begin
  v_uid_raw := nullif(btrim(p_user_id), '');
  if v_uid_raw is null then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;
  if v_uid_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return json_build_object('ok', false, 'error', 'invalid_user_id');
  end if;
  v_uid := v_uid_raw::uuid;

  v_dob_raw := nullif(btrim(p_date_of_birth), '');
  if v_dob_raw is null then
    v_dob := null;
  elsif v_dob_raw !~ '^\d{4}-\d{2}-\d{2}$' then
    v_dob := null;
  else
    v_dob := v_dob_raw::date;
  end if;

  return public.staff_update_profile(
    v_uid, p_full_name, p_phone, p_gender, v_dob, p_address, p_zip_code
  );
end;
$$;

grant execute on function public.staff_update_profile(uuid, text, text, text, date, text, text) to authenticated;
grant execute on function public.staff_update_profile_text(text, text, text, text, text, text, text) to authenticated;
