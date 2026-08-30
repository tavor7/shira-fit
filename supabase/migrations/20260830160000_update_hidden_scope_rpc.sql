-- Dedicated scope-only update: changes hide_from_athlete/coach/manager on an
-- already-hidden (session, athlete) pair without touching hidden_at/hidden_by,
-- so bulk scope changes from the Hidden Workouts screen don't churn the audit
-- trail the way re-calling super_user_hide_registration would.

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
  if not (p_hide_from_athlete or p_hide_from_coach or p_hide_from_manager) then
    return json_build_object('ok', false, 'error', 'no_scope_selected');
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
