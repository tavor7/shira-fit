-- These staff_* RPCs unconditionally blocked any target profile with role =
-- 'manager' (a leftover from when managers weren't editable via the shared
-- Edit users screen at all). Now that Roles/Coach-colors moved onto the
-- profile screen and managers appear in Edit users, a manager caller needs
-- to actually view/edit another manager's meta, name, phone, and enabled
-- state. The generic "not is_manager(caller) and target.role <> 'athlete'"
-- check right below already blocks coaches from touching manager (or other
-- non-athlete) profiles, so dropping the manager-only block is sufficient —
-- a manager caller passes through unchanged, a coach caller is still denied.

create or replace function public.staff_get_user_auth_meta(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
  v_last_sign_in timestamptz;
  v_email text;
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

  if not public.is_manager(v_uid) and v_target.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select u.last_sign_in_at, nullif(trim(coalesce(u.email, '')), '')
  into v_last_sign_in, v_email
  from auth.users u
  where u.id = p_user_id;

  return json_build_object(
    'ok', true,
    'user_id', p_user_id,
    'email', v_email,
    'last_sign_in_at', v_last_sign_in
  );
end;
$function$;

create or replace function public.staff_set_account_disabled(p_user_id uuid, p_disabled boolean)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

create or replace function public.staff_update_profile(
  p_user_id uuid,
  p_full_name text default null::text,
  p_phone text default null::text,
  p_gender text default null::text,
  p_date_of_birth date default null::date
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'user_not_found'); end if;

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
$function$;

create or replace function public.staff_update_profile(
  p_user_id uuid,
  p_full_name text default null::text,
  p_phone text default null::text,
  p_gender text default null::text,
  p_date_of_birth date default null::date,
  p_address text default null::text,
  p_zip_code text default null::text
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'user_not_found'); end if;

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
$function$;
