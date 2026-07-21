-- set_athlete_approval had drifted on the live DB: it was stuck on the
-- pre-activity-log version and never logged athlete_approved/athlete_rejected
-- events, even though migration 20260628200000 added this. Restore it, and
-- backfill events for athletes that were already approved while it was broken.
create or replace function public.set_athlete_approval(p_user_id uuid, p_status public.approval_status)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev public.approval_status;
  v_fn text;
  v_un text;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select p.approval_status, p.full_name, p.username
    into v_prev, v_fn, v_un
  from public.profiles p
  where p.user_id = p_user_id and p.role = 'athlete';

  if not found then
    return json_build_object('ok', false, 'error', 'not_athlete');
  end if;

  update public.profiles
  set approval_status = p_status
  where user_id = p_user_id and role = 'athlete';

  perform public._insert_activity_event(
    auth.uid(),
    case
      when p_status = 'approved'::public.approval_status then 'athlete_approved'
      when p_status = 'rejected'::public.approval_status then 'athlete_rejected'
      else 'athlete_approval_updated'
    end,
    'profile',
    p_user_id::text,
    jsonb_build_object(
      'target_user_id', p_user_id::text,
      'target_full_name', coalesce(v_fn, ''),
      'target_username', coalesce(v_un, ''),
      'previous_approval_status', v_prev::text,
      'new_approval_status', p_status::text
    )
  );
  return json_build_object('ok', true);
end;
$$;

-- Note: we deliberately do NOT backfill historical athlete_approved events.
-- profiles.updated_at is bumped by any profile write (a generic
-- set_updated_at trigger fires on every UPDATE, including the app writing
-- expo_push_token on each login), so it does not reflect the true approval
-- time and would show "last login" instead of "approved at" in the UI.
-- There is no reliable historical signal for when past approvals happened,
-- so "Recently approved" will only include approvals made after this fix.
