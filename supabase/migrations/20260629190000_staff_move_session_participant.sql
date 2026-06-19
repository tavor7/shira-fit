-- Staff: atomically move a participant from one not-yet-started session to another in the same week.

create or replace function public._staff_can_manage_session(p_uid uuid, p_sess public.training_sessions)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_manager(p_uid)
    or (
      p_sess.coach_id = p_uid
      and exists (select 1 from public.profiles p where p.user_id = p_uid and p.role = 'coach')
    );
$$;

create or replace function public._sessions_same_studio_week(p_date_a date, p_date_b date)
returns boolean
language sql
stable
as $$
  select public._week_start_sunday(p_date_a) = public._week_start_sunday(p_date_b);
$$;

create or replace function public.staff_move_session_participant(
  p_from_session_id uuid,
  p_to_session_id uuid,
  p_user_id uuid default null,
  p_manual_participant_id uuid default null,
  p_allow_over_capacity boolean default false,
  p_decrease_source_max boolean default false,
  p_increase_dest_max boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_from public.training_sessions%rowtype;
  v_to public.training_sessions%rowtype;
  v_count int;
  v_count_after int;
  v_reg public.session_registrations%rowtype;
  v_man public.session_manual_participants%rowtype;
  v_linked uuid;
  v_reactivated int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_from_session_id is null or p_to_session_id is null then
    return json_build_object('ok', false, 'error', 'invalid_session');
  end if;
  if p_from_session_id = p_to_session_id then
    return json_build_object('ok', false, 'error', 'same_session');
  end if;
  if (p_user_id is null) = (p_manual_participant_id is null) then
    return json_build_object('ok', false, 'error', 'invalid_participant');
  end if;

  select * into v_from from public.training_sessions where id = p_from_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  select * into v_to from public.training_sessions where id = p_to_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if not public._staff_can_manage_session(v_uid, v_from) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not public._staff_can_manage_session(v_uid, v_to) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public._session_has_started(v_from) or public._session_has_started(v_to) then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;
  if not public._sessions_same_studio_week(v_from.session_date, v_to.session_date) then
    return json_build_object('ok', false, 'error', 'same_week');
  end if;

  if p_user_id is not null then
    select * into v_reg
    from public.session_registrations
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active';
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_reg.attended is not null
      or v_reg.payment_method is not null
      or v_reg.amount_paid is not null
      or coalesce(v_reg.charge_no_show, false) then
      return json_build_object('ok', false, 'error', 'roster_locked');
    end if;
    if exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = p_user_id and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    if public.athlete_disabled_on_date(p_user_id, v_to.session_date) then
      return json_build_object('ok', false, 'error', 'account_disabled');
    end if;
  else
    select * into v_man
    from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_man.attended is not null
      or v_man.payment_method is not null
      or v_man.amount_paid is not null
      or coalesce(v_man.charge_no_show, false) then
      return json_build_object('ok', false, 'error', 'roster_locked');
    end if;
    if exists (
      select 1 from public.session_manual_participants
      where session_id = p_to_session_id and manual_participant_id = p_manual_participant_id
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    select mp.linked_user_id into v_linked
    from public.manual_participants mp
    where mp.id = p_manual_participant_id;
    if v_linked is not null and exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = v_linked and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
  end if;

  if coalesce(p_increase_dest_max, false) then
    if not public._staff_can_manage_session(v_uid, v_to) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    update public.training_sessions
    set max_participants = max_participants + 1
    where id = p_to_session_id;
    select * into v_to from public.training_sessions where id = p_to_session_id;
  end if;

  v_count := public.active_registration_count(p_to_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_to.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  if coalesce(p_decrease_source_max, false) then
    if not public._staff_can_manage_session(v_uid, v_from) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    if v_from.max_participants <= 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    v_count_after := public.active_registration_count(p_from_session_id) - 1;
    if v_count_after > v_from.max_participants - 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    update public.training_sessions
    set max_participants = max_participants - 1
    where id = p_from_session_id;
  end if;

  if p_user_id is not null then
    update public.session_registrations
    set status = 'cancelled'
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active';
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    insert into public.registration_history (session_id, user_id, event_type)
    values (p_from_session_id, p_user_id, 'removed');

    update public.session_registrations
    set
      status = 'active',
      registered_at = now(),
      attended = null,
      payment_method = null,
      amount_paid = null,
      charge_no_show = false,
      payment_recorded_by = null,
      payment_recorded_at = null
    where session_id = p_to_session_id and user_id = p_user_id and status = 'cancelled';
    get diagnostics v_reactivated = row_count;

    if v_reactivated = 0 then
      insert into public.session_registrations (session_id, user_id, status, registered_at)
      values (p_to_session_id, p_user_id, 'active', now());
    end if;

    insert into public.registration_history (session_id, user_id, event_type)
    values (p_to_session_id, p_user_id, 'registered');

    delete from public.waitlist_requests
    where session_id = p_to_session_id and user_id = p_user_id;
  else
    delete from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id;
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;

    insert into public.session_manual_participants (session_id, manual_participant_id)
    values (p_to_session_id, p_manual_participant_id);
  end if;

  perform public._insert_activity_event(
    v_uid,
    'participant_moved',
    'session',
    p_to_session_id::text,
    jsonb_build_object(
      'from_session_id', p_from_session_id,
      'to_session_id', p_to_session_id,
      'user_id', p_user_id,
      'manual_participant_id', p_manual_participant_id
    )
  );

  return json_build_object('ok', true);
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'already_in_session');
end;
$$;

grant execute on function public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean) to authenticated;
