-- Persist signup address/zip from auth metadata (client profile.update fails without a session).

create or replace function public._apply_signup_profile_from_metadata(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_meta jsonb;
  v_address text;
  v_zip_code text;
  v_dob date;
begin
  if p_user_id is null then
    return false;
  end if;

  select raw_user_meta_data into v_meta
  from auth.users
  where id = p_user_id;

  if not found then
    return false;
  end if;

  v_address := nullif(trim(coalesce(v_meta->>'address', '')), '');
  v_zip_code := nullif(trim(coalesce(v_meta->>'zip_code', '')), '');
  v_dob := nullif(trim(coalesce(v_meta->>'date_of_birth', '')), '')::date;

  update public.profiles p
  set
    full_name = coalesce(nullif(trim(v_meta->>'full_name'), ''), p.full_name),
    phone = coalesce(nullif(trim(v_meta->>'phone'), ''), p.phone),
    address = coalesce(v_address, p.address),
    zip_code = coalesce(v_zip_code, p.zip_code),
    gender = case
      when lower(trim(coalesce(v_meta->>'gender', ''))) in ('male', 'female')
        then lower(trim(v_meta->>'gender'))
      else p.gender
    end,
    date_of_birth = coalesce(v_dob, p.date_of_birth),
    age = coalesce(
      extract(year from age(coalesce(v_dob, p.date_of_birth)))::int,
      p.age
    ),
    health_declaration_confirmed_at = coalesce(
      p.health_declaration_confirmed_at,
      case when public._signup_health_confirmed_from_meta(v_meta) then now() end
    )
  where p.user_id = p_user_id
    and (
      v_address is not null
      or v_zip_code is not null
      or nullif(trim(v_meta->>'full_name'), '') is not null
      or nullif(trim(v_meta->>'phone'), '') is not null
      or v_dob is not null
      or public._signup_health_confirmed_from_meta(v_meta)
    );

  return found;
end;
$$;

create or replace function public.sync_signup_profile_from_metadata()
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_applied boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  v_applied := public._apply_signup_profile_from_metadata(v_uid);
  return json_build_object('ok', true, 'applied', v_applied);
end;
$$;

grant execute on function public.sync_signup_profile_from_metadata() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dob date;
  v_gender text;
  v_username text;
  v_age int;
  v_address text;
  v_zip_code text;
  v_health_confirmed boolean;
begin
  v_dob := nullif(trim(new.raw_user_meta_data->>'date_of_birth'), '')::date;
  if v_dob is null then
    v_dob := '2000-01-01'::date;
  end if;

  v_gender := lower(trim(coalesce(new.raw_user_meta_data->>'gender', 'male')));
  if v_gender not in ('male', 'female') then
    v_gender := 'male';
  end if;

  v_username := split_part(new.email, '@', 1) || '_' || left(replace(new.id::text, '-', ''), 8);
  v_age := extract(year from age(v_dob))::int;
  v_address := coalesce(nullif(trim(coalesce(new.raw_user_meta_data->>'address', '')), ''), '');
  v_zip_code := coalesce(nullif(trim(coalesce(new.raw_user_meta_data->>'zip_code', '')), ''), '');
  v_health_confirmed := public._signup_health_confirmed_from_meta(new.raw_user_meta_data);

  insert into public.profiles (
    user_id,
    username,
    full_name,
    phone,
    age,
    gender,
    date_of_birth,
    address,
    zip_code,
    health_declaration_confirmed_at,
    approval_status,
    role
  )
  values (
    new.id,
    v_username,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), v_username),
    coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), ''),
    v_age,
    v_gender,
    v_dob,
    v_address,
    v_zip_code,
    case when v_health_confirmed then now() else null end,
    'pending',
    'athlete'
  )
  on conflict (user_id) do update
  set
    full_name = coalesce(excluded.full_name, profiles.full_name),
    phone = coalesce(nullif(excluded.phone, ''), profiles.phone),
    address = coalesce(nullif(excluded.address, ''), profiles.address),
    zip_code = coalesce(nullif(excluded.zip_code, ''), profiles.zip_code),
    gender = excluded.gender,
    date_of_birth = excluded.date_of_birth,
    age = excluded.age,
    health_declaration_confirmed_at = coalesce(
      profiles.health_declaration_confirmed_at,
      excluded.health_declaration_confirmed_at
    );

  perform public._apply_signup_profile_from_metadata(new.id);

  return new;
exception
  when unique_violation then
    perform public._apply_signup_profile_from_metadata(new.id);
    return new;
end;
$$;

create or replace function public.tg_auth_user_signup_consent()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public._apply_signup_profile_from_metadata(new.id);
  perform public._try_sync_signup_consent_for_user(new.id);
  return new;
end;
$$;

-- Backfill athletes missing address/zip when signup metadata still has them.
do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select u.id
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where p.role = 'athlete'
      and (
        nullif(trim(coalesce(p.address, '')), '') is null
        or nullif(trim(coalesce(p.zip_code, '')), '') is null
      )
      and (
        nullif(trim(coalesce(u.raw_user_meta_data->>'address', '')), '') is not null
        or nullif(trim(coalesce(u.raw_user_meta_data->>'zip_code', '')), '') is not null
      )
  loop
    perform public._apply_signup_profile_from_metadata(v_user_id);
  end loop;
end;
$$;
