-- Bug: _apply_signup_profile_from_metadata() ran on every login (via
-- sync_signup_profile_from_metadata, called from AuthContext.loadProfile) and preferred the
-- frozen auth.users.raw_user_meta_data value over the current profiles row. Staff edits (via
-- staff_update_profile / Edit Users) only ever write to public.profiles, never to
-- auth.users.raw_user_meta_data, so any staff-edited full_name/phone/gender/date_of_birth/
-- address/zip_code silently reverted back to whatever was typed at signup the next time the
-- athlete opened the app. Fix: only use signup metadata to backfill fields that are still
-- genuinely empty on the profile; once a profile field has a value, it wins.

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
    full_name = coalesce(nullif(trim(p.full_name), ''), nullif(trim(v_meta->>'full_name'), '')),
    phone = coalesce(nullif(trim(p.phone), ''), nullif(trim(v_meta->>'phone'), '')),
    address = coalesce(nullif(trim(coalesce(p.address, '')), ''), v_address),
    zip_code = coalesce(nullif(trim(coalesce(p.zip_code, '')), ''), v_zip_code),
    gender = case
      when p.gender in ('male', 'female') then p.gender
      when lower(trim(coalesce(v_meta->>'gender', ''))) in ('male', 'female')
        then lower(trim(v_meta->>'gender'))
      else p.gender
    end,
    date_of_birth = coalesce(p.date_of_birth, v_dob),
    age = coalesce(
      extract(year from age(coalesce(p.date_of_birth, v_dob)))::int,
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

-- Restore the two athletes caught in the revert loop before this fix.
update public.profiles set full_name = 'יעל קליינמן'
where user_id = '16994af7-27d7-49c5-a1e7-1f89759a3eb8' and full_name = 'Imuncosher1!';

update public.profiles set full_name = 'Shir Baum'
where user_id = 'b1c2487c-2013-4d96-af17-139cea6d136b' and full_name = 'Short Baum';
