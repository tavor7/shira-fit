-- Compatibility wrapper for PostgREST schema cache matching.
-- Sometimes PostgREST can't resolve the original function when JSON params
-- are inferred as `text` (e.g. p_date_of_birth) instead of `date`.
--
-- This wrapper accepts DOB as text and casts internally, then calls the
-- existing `public.staff_update_profile`.

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
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  v_uid := btrim(p_user_id)::uuid;
  v_dob := case
    when p_date_of_birth is null or btrim(p_date_of_birth) = '' then null
    else btrim(p_date_of_birth)::date
  end;

  return public.staff_update_profile(v_uid, p_full_name, p_phone, p_gender, v_dob);
exception when others then
  return json_build_object('ok', false, 'error', 'invalid_input');
end;
$$;

grant execute on function public.staff_update_profile_text(text, text, text, text, text) to authenticated;

