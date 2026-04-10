-- Richer activity log metadata: who was approved/rejected, session field diffs, profile value before/after.

-- Athlete approval: capture target identity + previous status.
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

  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (
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

-- Profile updates: store before/after for changed fields only.
create or replace function public.tg_profiles_activity_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if old.full_name is distinct from new.full_name then
    v_changes := v_changes || jsonb_build_object(
      'full_name', jsonb_build_object('from', coalesce(old.full_name, ''), 'to', coalesce(new.full_name, ''))
    );
  end if;
  if old.phone is distinct from new.phone then
    v_changes := v_changes || jsonb_build_object(
      'phone', jsonb_build_object('from', coalesce(old.phone, ''), 'to', coalesce(new.phone, ''))
    );
  end if;
  if old.gender is distinct from new.gender then
    v_changes := v_changes || jsonb_build_object(
      'gender', jsonb_build_object('from', coalesce(old.gender, ''), 'to', coalesce(new.gender, ''))
    );
  end if;
  if old.date_of_birth is distinct from new.date_of_birth then
    v_changes := v_changes || jsonb_build_object(
      'date_of_birth', jsonb_build_object('from', coalesce(old.date_of_birth::text, ''), 'to', coalesce(new.date_of_birth::text, ''))
    );
  end if;
  if old.username is distinct from new.username then
    v_changes := v_changes || jsonb_build_object(
      'username', jsonb_build_object('from', coalesce(old.username, ''), 'to', coalesce(new.username, ''))
    );
  end if;

  if v_changes <> '{}'::jsonb then
    perform public._insert_activity_event(
      auth.uid(),
      'profile_updated',
      'profile',
      new.user_id::text,
      jsonb_build_object('changes', v_changes, 'edited_user_id', new.user_id::text)
    );
  end if;
  return new;
end;
$$;

-- Training sessions: snapshot on insert/delete; field-level diff on update.
create or replace function public.tg_training_sessions_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_changes jsonb := '{}'::jsonb;
  v_snap jsonb;
begin
  if tg_op = 'INSERT' then
    v_snap := jsonb_build_object(
      'session_date', new.session_date,
      'start_time', new.start_time::text,
      'coach_id', new.coach_id::text,
      'max_participants', new.max_participants,
      'is_open_for_registration', new.is_open_for_registration,
      'duration_minutes', new.duration_minutes,
      'is_hidden', new.is_hidden
    );
    perform public._insert_activity_event(
      uid,
      'session_created',
      'training_session',
      new.id::text,
      jsonb_build_object('after', v_snap)
    );
  elsif tg_op = 'UPDATE' then
    if old.session_date is distinct from new.session_date then
      v_changes := v_changes || jsonb_build_object(
        'session_date', jsonb_build_object('from', old.session_date, 'to', new.session_date)
      );
    end if;
    if old.start_time is distinct from new.start_time then
      v_changes := v_changes || jsonb_build_object(
        'start_time', jsonb_build_object('from', old.start_time::text, 'to', new.start_time::text)
      );
    end if;
    if old.coach_id is distinct from new.coach_id then
      v_changes := v_changes || jsonb_build_object(
        'coach_id', jsonb_build_object('from', old.coach_id::text, 'to', new.coach_id::text)
      );
    end if;
    if old.max_participants is distinct from new.max_participants then
      v_changes := v_changes || jsonb_build_object(
        'max_participants', jsonb_build_object('from', old.max_participants, 'to', new.max_participants)
      );
    end if;
    if old.is_open_for_registration is distinct from new.is_open_for_registration then
      v_changes := v_changes || jsonb_build_object(
        'is_open_for_registration', jsonb_build_object('from', old.is_open_for_registration, 'to', new.is_open_for_registration)
      );
    end if;
    if old.duration_minutes is distinct from new.duration_minutes then
      v_changes := v_changes || jsonb_build_object(
        'duration_minutes', jsonb_build_object('from', old.duration_minutes, 'to', new.duration_minutes)
      );
    end if;
    if old.is_hidden is distinct from new.is_hidden then
      v_changes := v_changes || jsonb_build_object(
        'is_hidden', jsonb_build_object('from', old.is_hidden, 'to', new.is_hidden)
      );
    end if;
    if v_changes <> '{}'::jsonb then
      perform public._insert_activity_event(
        uid,
        'session_updated',
        'training_session',
        new.id::text,
        jsonb_build_object('changes', v_changes)
      );
    end if;
  elsif tg_op = 'DELETE' then
    v_snap := jsonb_build_object(
      'session_date', old.session_date,
      'start_time', old.start_time::text,
      'coach_id', old.coach_id::text,
      'max_participants', old.max_participants,
      'is_open_for_registration', old.is_open_for_registration,
      'duration_minutes', old.duration_minutes,
      'is_hidden', old.is_hidden
    );
    perform public._insert_activity_event(
      uid,
      'session_deleted',
      'training_session',
      old.id::text,
      jsonb_build_object('before', v_snap)
    );
  end if;
  return coalesce(new, old);
end;
$$;
