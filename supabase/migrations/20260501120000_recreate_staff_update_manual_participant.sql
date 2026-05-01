-- Ensure staff_update_manual_participant exists for PostgREST (fixes "not found in schema cache"
-- when the original migration was never applied or an older DB is missing this RPC).

drop function if exists public.staff_update_manual_participant(uuid, text, text, text, date, text);

create or replace function public.staff_update_manual_participant(
  p_manual_participant_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_notes text default null
)
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
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.manual_participants
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    gender = coalesce(nullif(trim(p_gender), ''), gender),
    date_of_birth = coalesce(p_date_of_birth, date_of_birth),
    notes = coalesce(p_notes, notes)
  where id = p_manual_participant_id;

  if not found then
    return json_build_object('ok', false, 'error', 'manual_participant_not_found');
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.staff_update_manual_participant(uuid, text, text, text, date, text) to authenticated;
