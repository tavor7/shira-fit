-- Safer compat wrapper for staff_update_profile_text.
-- Prevents runtime exceptions on malformed inputs by guarding casts with regex.

create or replace function public.staff_update_profile_text(
  p_user_id text,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth text default null
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
  -- UUID guard (avoid exceptions on malformed input).
  if v_uid_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return json_build_object('ok', false, 'error', 'invalid_user_id');
  end if;
  v_uid := v_uid_raw::uuid;

  v_dob_raw := nullif(btrim(p_date_of_birth), '');
  if v_dob_raw is null then
    v_dob := null;
  elsif v_dob_raw !~ '^\d{4}-\d{2}-\d{2}$' then
    -- If DOB isn't in YYYY-MM-DD, treat it as NULL (no exception).
    v_dob := null;
  else
    v_dob := v_dob_raw::date;
  end if;

  return public.staff_update_profile(v_uid, p_full_name, p_phone, p_gender, v_dob);
end;
$$;

grant execute on function public.staff_update_profile_text(text, text, text, text, text) to authenticated;

