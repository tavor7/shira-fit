-- Date of birth, gender male/female only, username auto from email; age optional (derived or null)

alter table public.profiles add column if not exists date_of_birth date;

alter table public.profiles alter column age drop not null;

-- Normalize existing genders before constraint
update public.profiles set gender = 'male' where lower(trim(gender)) not in ('male', 'female');

alter table public.profiles drop constraint if exists profiles_gender_check;
alter table public.profiles add constraint profiles_gender_check check (gender in ('male', 'female'));

-- New signups: username unique — use email local part + short id suffix in trigger
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_dob date;
  v_gender text;
  v_username text;
  v_age int;
begin
  v_dob := nullif(trim(new.raw_user_meta_data->>'date_of_birth'), '')::date;
  if v_dob is null then v_dob := '2000-01-01'::date; end if;

  v_gender := lower(trim(coalesce(new.raw_user_meta_data->>'gender', 'male')));
  if v_gender not in ('male', 'female') then v_gender := 'male'; end if;

  v_username := split_part(new.email, '@', 1) || '_' || left(replace(new.id::text, '-', ''), 8);
  v_age := extract(year from age(v_dob))::int;

  insert into public.profiles (user_id, username, full_name, phone, age, gender, date_of_birth, approval_status, role)
  values (
    new.id,
    v_username,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), v_username),
    coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), ''),
    v_age,
    v_gender,
    v_dob,
    'pending',
    'athlete'
  );
  return new;
exception when unique_violation then
  return new;
end;
$$;
