-- Cancelling sets session_registrations.status = 'cancelled' but keeps the (session_id, user_id) row.
-- A plain INSERT then hits the unique constraint; the exception handler returned already_registered.
-- Reactivate cancelled rows (and clear staff attendance/payment fields) like coach_add_athlete does.

create or replace function public.register_for_session(p_session_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;
  if not v_sess.is_open_for_registration then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  if exists (
    select 1 from session_registrations
    where session_id = p_session_id and user_id = v_uid and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;

  insert into session_registrations (session_id, user_id, status, registered_at)
  values (p_session_id, v_uid, 'active', now())
  on conflict (session_id, user_id) do update
  set
    status = 'active',
    registered_at = now(),
    attended = null,
    payment_method = null,
    amount_paid = null
  where session_registrations.status = 'cancelled';

  insert into registration_history (session_id, user_id, event_type) values (p_session_id, v_uid, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = v_uid;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.register_for_session(uuid) to authenticated;
