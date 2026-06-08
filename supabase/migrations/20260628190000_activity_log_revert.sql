-- Allow managers to revert selected activity-log actions when metadata supports a safe undo.

alter table public.user_activity_events
  add column if not exists reverted_at timestamptz,
  add column if not exists reverted_by uuid references auth.users (id) on delete set null;

create index if not exists user_activity_events_reverted_at_idx
  on public.user_activity_events (reverted_at)
  where reverted_at is not null;

create or replace function public._activity_log_enabled()
returns boolean
language sql
stable
set search_path to public, pg_temp
as $$
  select coalesce(nullif(current_setting('shira.skip_activity_log', true), ''), 'off') <> 'on';
$$;

create or replace function public._insert_activity_event(
  p_actor uuid,
  p_event_type text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._activity_log_enabled() then
    return;
  end if;
  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (
    p_actor,
    p_event_type,
    nullif(trim(coalesce(p_target_type, '')), ''),
    nullif(trim(coalesce(p_target_id, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );
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
        is_hidden = case when v_changes ? 'is_hidden' then (v_changes->'is_hidden'->>'from')::boolean else s.is_hidden end
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

grant execute on function public.manager_activity_revert_info(uuid) to authenticated;
grant execute on function public.manager_revert_activity_event(uuid) to authenticated;

comment on function public.manager_activity_revert_info(uuid) is
  'Returns whether a manager can safely revert a logged activity event.';
comment on function public.manager_revert_activity_event(uuid) is
  'Reverts a supported activity-log event using stored before/after metadata.';
