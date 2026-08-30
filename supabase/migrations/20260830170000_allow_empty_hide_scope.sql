-- Allow the global scope control to turn a hidden record's audience down to
-- "no one" (equivalent to fully visible, but still tracked in the Hidden
-- Workouts list for easy re-enable) instead of requiring at least one
-- audience. super_user_hide_registration (creating a NEW hide) still
-- requires at least one — this relaxation only applies to adjusting an
-- already-hidden record's scope.

create or replace function public.super_user_update_hidden_scope(
  p_session_id uuid,
  p_user_id uuid,
  p_hide_from_athlete boolean,
  p_hide_from_coach boolean,
  p_hide_from_manager boolean
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_updated int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_super_user(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.super_user_hidden_registrations
  set hide_from_athlete = p_hide_from_athlete,
      hide_from_coach = p_hide_from_coach,
      hide_from_manager = p_hide_from_manager
  where session_id = p_session_id and user_id = p_user_id and unhidden_at is null;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return json_build_object('ok', false, 'error', 'not_hidden');
  end if;

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.super_user_update_hidden_scope(uuid, uuid, boolean, boolean, boolean) to authenticated;
