-- Extend activity-log revert for newly logged action types (+ custom slot price on session revert).

create or replace function public._activity_jsonb_to_boolean(p_val jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when p_val is null or p_val = 'null'::jsonb then null
    else (p_val #>> '{}')::boolean
  end;
$$;

create or replace function public._activity_jsonb_to_numeric(p_val jsonb)
returns numeric
language sql
immutable
as $$
  select case
    when p_val is null or p_val = 'null'::jsonb then null
    else (p_val #>> '{}')::numeric
  end;
$$;

create or replace function public.manager_activity_revert_info(p_event_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.user_activity_events%rowtype;
  v_changes jsonb;
  v_sid uuid;
  v_uid uuid;
  v_manual_id uuid;
  v_reg_id uuid;
  v_sess public.training_sessions%rowtype;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into ev from public.user_activity_events where id = p_event_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if ev.reverted_at is not null then
    return json_build_object('ok', true, 'can_revert', false, 'reason', 'already_reverted');
  end if;

  v_changes := coalesce(ev.metadata->'changes', '{}'::jsonb);

  case ev.event_type
    when 'profile_updated' then
      if v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'no_changes');
      end if;
      if ev.target_id is null or not exists (select 1 from public.profiles where user_id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'profile_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'athlete_approved', 'athlete_rejected', 'athlete_approval_updated' then
      if ev.metadata->>'previous_approval_status' is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'no_previous_status');
      end if;
      if ev.target_id is null or not exists (
        select 1 from public.profiles where user_id = ev.target_id::uuid and role = 'athlete'
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'athlete_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_updated' then
      if v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'no_changes');
      end if;
      if ev.target_id is null or not exists (select 1 from public.training_sessions where id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_created' then
      if ev.target_id is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_missing');
      end if;
      v_sid := ev.target_id::uuid;
      if not exists (select 1 from public.training_sessions where id = v_sid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_missing');
      end if;
      if exists (select 1 from public.session_registrations where session_id = v_sid and status = 'active') then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_has_registrations');
      end if;
      if exists (select 1 from public.session_manual_participants where session_id = v_sid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_has_participants');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_registration' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_uid := nullif(ev.metadata->>'user_id', '')::uuid;
      if v_sid is null or v_uid is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_registration_context');
      end if;
      if not exists (
        select 1 from public.session_registrations
        where session_id = v_sid and user_id = v_uid and status = 'active'
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'registration_not_active');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_registration_cancelled' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_uid := nullif(ev.metadata->>'user_id', '')::uuid;
      if v_sid is null or v_uid is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_registration_context');
      end if;
      select * into v_sess from public.training_sessions where id = v_sid;
      if not found then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_missing');
      end if;
      if public._session_has_ended(v_sess) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_ended');
      end if;
      if public.active_registration_count(v_sid) >= v_sess.max_participants then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_full');
      end if;
      if not exists (
        select 1 from public.session_registrations
        where session_id = v_sid and user_id = v_uid and status = 'cancelled'
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'registration_not_cancelled');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_registration_status_changed' then
      v_reg_id := nullif(ev.target_id, '')::uuid;
      if v_reg_id is null or ev.metadata->>'from' is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_status_context');
      end if;
      if not exists (select 1 from public.session_registrations where id = v_reg_id) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'registration_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_manual_participant_added' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_manual_id := nullif(ev.metadata->>'manual_participant_id', '')::uuid;
      if v_sid is null or v_manual_id is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_registration_context');
      end if;
      if not exists (
        select 1 from public.session_manual_participants
        where session_id = v_sid and manual_participant_id = v_manual_id
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'manual_participant_not_in_session');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_manual_participant_removed' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_manual_id := nullif(ev.metadata->>'manual_participant_id', '')::uuid;
      if v_sid is null or v_manual_id is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_registration_context');
      end if;
      select * into v_sess from public.training_sessions where id = v_sid;
      if not found then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_missing');
      end if;
      if public._session_has_ended(v_sess) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_ended');
      end if;
      if public.active_registration_count(v_sid) >= v_sess.max_participants then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_full');
      end if;
      if exists (
        select 1 from public.session_manual_participants
        where session_id = v_sid and manual_participant_id = v_manual_id
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'manual_participant_already_in_session');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'registration_attendance_updated' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_uid := nullif(ev.metadata->>'user_id', '')::uuid;
      if v_sid is null or v_uid is null or v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_attendance_context');
      end if;
      if not exists (
        select 1 from public.session_registrations
        where id = ev.target_id::uuid and status = 'active'
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'registration_not_active');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'manual_participant_attendance_updated' then
      v_sid := nullif(ev.metadata->>'session_id', '')::uuid;
      v_manual_id := nullif(ev.metadata->>'manual_participant_id', '')::uuid;
      if v_sid is null or v_manual_id is null or v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_attendance_context');
      end if;
      if not exists (
        select 1 from public.session_manual_participants
        where id = ev.target_id::uuid
      ) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'manual_participant_not_in_session');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'user_role_changed' then
      if ev.metadata->>'previous_role' is null or ev.target_id is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_role_context');
      end if;
      if not exists (select 1 from public.profiles where user_id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'profile_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'cancellation_charge_updated', 'cancellation_penalty_collected_updated' then
      if ev.target_id is null or v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_cancellation_context');
      end if;
      if not exists (select 1 from public.cancellations where id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'cancellation_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'registration_opening_schedule_updated' then
      if v_changes = '{}'::jsonb then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'no_changes');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_note_created' then
      if ev.target_id is null or not exists (select 1 from public.session_notes where id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_note_missing');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    when 'session_note_deleted' then
      if ev.target_id is null or ev.metadata->>'body' is null then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_note_context');
      end if;
      if exists (select 1 from public.session_notes where id = ev.target_id::uuid) then
        return json_build_object('ok', true, 'can_revert', false, 'reason', 'session_note_already_exists');
      end if;
      return json_build_object('ok', true, 'can_revert', true);

    else
      return json_build_object('ok', true, 'can_revert', false, 'reason', 'not_revertible');
  end case;
end;
$$;

create or replace function public.manager_revert_activity_event(p_event_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.user_activity_events%rowtype;
  info json;
  v_changes jsonb;
  v_sid uuid;
  v_uid uuid;
  v_manual_id uuid;
  v_reg_id uuid;
  v_res json;
  v_prev public.approval_status;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  info := public.manager_activity_revert_info(p_event_id);
  if coalesce((info->>'ok')::boolean, false) is not true then
    return info;
  end if;
  if coalesce((info->>'can_revert')::boolean, false) is not true then
    return json_build_object('ok', false, 'error', coalesce(info->>'reason', 'not_revertible'));
  end if;

  select * into ev from public.user_activity_events where id = p_event_id for update;
  if ev.reverted_at is not null then
    return json_build_object('ok', false, 'error', 'already_reverted');
  end if;

  v_changes := coalesce(ev.metadata->'changes', '{}'::jsonb);
  perform set_config('shira.skip_activity_log', 'on', true);

  case ev.event_type
    when 'profile_updated' then
      update public.profiles p
      set
        full_name = case when v_changes ? 'full_name' then v_changes->'full_name'->>'from' else p.full_name end,
        phone = case when v_changes ? 'phone' then v_changes->'phone'->>'from' else p.phone end,
        gender = case when v_changes ? 'gender' then v_changes->'gender'->>'from' else p.gender end,
        date_of_birth = case
          when v_changes ? 'date_of_birth' and nullif(v_changes->'date_of_birth'->>'from', '') is not null
            then (v_changes->'date_of_birth'->>'from')::date
          when v_changes ? 'date_of_birth' then null
          else p.date_of_birth
        end,
        username = case when v_changes ? 'username' then v_changes->'username'->>'from' else p.username end
      where p.user_id = ev.target_id::uuid;

    when 'athlete_approved', 'athlete_rejected', 'athlete_approval_updated' then
      v_prev := (ev.metadata->>'previous_approval_status')::public.approval_status;
      update public.profiles
      set approval_status = v_prev
      where user_id = ev.target_id::uuid and role = 'athlete';

    when 'session_updated' then
      update public.training_sessions s
      set
        session_date = case when v_changes ? 'session_date' then (v_changes->'session_date'->>'from')::date else s.session_date end,
        start_time = case when v_changes ? 'start_time' then (v_changes->'start_time'->>'from')::time else s.start_time end,
        coach_id = case when v_changes ? 'coach_id' then (v_changes->'coach_id'->>'from')::uuid else s.coach_id end,
        max_participants = case when v_changes ? 'max_participants' then (v_changes->'max_participants'->>'from')::int else s.max_participants end,
        is_open_for_registration = case when v_changes ? 'is_open_for_registration' then (v_changes->'is_open_for_registration'->>'from')::boolean else s.is_open_for_registration end,
        duration_minutes = case when v_changes ? 'duration_minutes' then (v_changes->'duration_minutes'->>'from')::int else s.duration_minutes end,
        is_hidden = case when v_changes ? 'is_hidden' then (v_changes->'is_hidden'->>'from')::boolean else s.is_hidden end,
        custom_slot_price_ils = case
          when v_changes ? 'custom_slot_price_ils' and v_changes->'custom_slot_price_ils'->'from' = 'null'::jsonb then null
          when v_changes ? 'custom_slot_price_ils' then (v_changes->'custom_slot_price_ils'->>'from')::numeric
          else s.custom_slot_price_ils
        end
      where s.id = ev.target_id::uuid;

    when 'session_created' then
      delete from public.training_sessions where id = ev.target_id::uuid;

    when 'session_registration' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.manager_remove_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'remove_failed'));
      end if;

    when 'session_registration_cancelled' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.coach_add_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'session_registration_status_changed' then
      v_reg_id := ev.target_id::uuid;
      update public.session_registrations
      set status = (ev.metadata->>'from')::public.registration_status
      where id = v_reg_id;

    when 'session_manual_participant_added' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      delete from public.session_manual_participants
      where session_id = v_sid and manual_participant_id = v_manual_id;

    when 'session_manual_participant_removed' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      v_res := public.add_manual_participant_to_session(v_sid, v_manual_id);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'registration_attendance_updated' then
      update public.session_registrations r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'manual_participant_attendance_updated' then
      update public.session_manual_participants r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'user_role_changed' then
      update public.profiles
      set role = (ev.metadata->>'previous_role')::public.user_role
      where user_id = ev.target_id::uuid;

    when 'cancellation_charge_updated' then
      update public.cancellations
      set
        charged_full_price = coalesce(public._activity_jsonb_to_boolean(v_changes->'charged_full_price'->'from'), false),
        penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'cancellation_penalty_collected_updated' then
      update public.cancellations
      set penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'registration_opening_schedule_updated' then
      update public.app_settings
      set
        registration_open_weekday = (v_changes->'registration_open_weekday'->>'from')::int,
        registration_open_time = (v_changes->'registration_open_time'->>'from')::time,
        updated_at = now()
      where id = 1;

    when 'session_note_created' then
      delete from public.session_notes where id = ev.target_id::uuid;

    when 'session_note_deleted' then
      insert into public.session_notes (id, session_id, author_id, body)
      values (
        ev.target_id::uuid,
        (ev.metadata->>'session_id')::uuid,
        (ev.metadata->>'author_id')::uuid,
        ev.metadata->>'body'
      );

    else
      perform set_config('shira.skip_activity_log', 'off', true);
      return json_build_object('ok', false, 'error', 'not_revertible');
  end case;

  update public.user_activity_events
  set reverted_at = now(), reverted_by = auth.uid()
  where id = p_event_id;

  perform set_config('shira.skip_activity_log', 'off', true);

  perform public._insert_activity_event(
    auth.uid(),
    'activity_event_reverted',
    'user_activity_event',
    p_event_id::text,
    jsonb_build_object('reverted_event_type', ev.event_type)
  );

  return json_build_object('ok', true);
exception
  when others then
    perform set_config('shira.skip_activity_log', 'off', true);
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;
