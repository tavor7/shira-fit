-- Manager operational notifications must only fire when the departing ATHLETE performed the
-- cancellation themselves -- never when staff (manager/coach) removed them, moved them, or
-- reverted an activity-log entry on their behalf. Previously these triggers fired on every
-- active->cancelled status flip / manual-participant delete regardless of who caused it, so a
-- manager who removed an athlete (or a coach, or another manager's revert) would immediately get
-- notified about the very action they just took -- pure noise.
--
-- auth.uid() inside these triggers resolves to the original RPC caller (cancel_registration,
-- manager_remove_athlete, coach_remove_athlete, staff_move_session_participant, or
-- manager_revert_activity_event's internal manager_remove_athlete call) because the trigger fires
-- synchronously within that same transaction/session -- so comparing it to the departing
-- registration's user_id is a reliable self-vs-staff signal requiring no new actor column.
--
-- Manual participants have no login / auth.uid() of their own, so every departure on that path is
-- necessarily a staff action -- that trigger now never dispatches.

create or replace function public.tg_manager_notify_on_registration_departure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  -- Only the departing athlete acting on their own registration should trigger this notification.
  -- auth.uid() is null (service-role/background job) or some other user's id (manager/coach
  -- removal, the source side of staff_move_session_participant, manager_revert_activity_event) in
  -- every other case.
  if auth.uid() is distinct from new.user_id then
    return new;
  end if;

  select full_name into v_name from public.profiles where user_id = new.user_id;
  perform public.evaluate_manager_operational_departure(
    new.session_id,
    'reg_departure:' || new.id::text,
    v_name
  );
  return new;
exception
  when others then
    -- Never let a notification-side failure block the registration status change itself.
    return new;
end;
$$;

create or replace function public.tg_manager_notify_on_manual_departure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Manual participants can never cancel themselves (no account, no auth.uid()) -- every removal
  -- here is a staff action, so per the athlete-only rule this path never notifies.
  return old;
end;
$$;

comment on function public.tg_manager_notify_on_registration_departure() is
  'Fires on every active->cancelled status flip, but only dispatches a manager notification when '
  'auth.uid() equals the departing registration''s own user_id -- i.e. the athlete cancelled '
  'themselves. Staff-initiated removals (manager_remove_athlete, coach_remove_athlete, '
  'staff_move_session_participant''s source-session decrement, manager_revert_activity_event) never '
  'notify, since staff already know about their own action.';
comment on function public.tg_manager_notify_on_manual_departure() is
  'Fires on every session_manual_participants delete, but never dispatches a notification: manual '
  'participants have no account of their own, so every departure here is necessarily a staff '
  'action, never an athlete self-cancellation.';
