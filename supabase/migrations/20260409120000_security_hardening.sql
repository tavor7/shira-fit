-- Security / integrity hardening
-- - Prevent bypassing business rules by inserting directly into tables
-- - Ensure coaches can only mutate their own sessions
-- - Limit participant name exposure for athletes

-- 1) Registrations + waitlist: disallow direct inserts (use RPCs)
drop policy if exists "reg_insert_self" on public.session_registrations;
drop policy if exists "waitlist_insert_self" on public.waitlist_requests;

-- 2) Manual session participants: enforce coach ownership at table level too
drop policy if exists session_manual_participants_insert_staff on public.session_manual_participants;
create policy session_manual_participants_insert_staff on public.session_manual_participants
for insert
with check (
  public.is_manager(auth.uid())
  or (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and exists (
      select 1
      from public.training_sessions s
      where s.id = session_manual_participants.session_id
        and s.coach_id = auth.uid()
    )
  )
);

drop policy if exists session_manual_participants_update_staff on public.session_manual_participants;
create policy session_manual_participants_update_staff on public.session_manual_participants
for update
using (
  public.is_manager(auth.uid())
  or (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and exists (
      select 1
      from public.training_sessions s
      where s.id = session_manual_participants.session_id
        and s.coach_id = auth.uid()
    )
  )
)
with check (
  public.is_manager(auth.uid())
  or (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and exists (
      select 1
      from public.training_sessions s
      where s.id = session_manual_participants.session_id
        and s.coach_id = auth.uid()
    )
  )
);

-- 3) Staff add athlete: ensure a coach can only add to own session
create or replace function public.coach_add_athlete(p_session_id uuid, p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = p_user_id and approval_status = 'approved' and role = 'athlete'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  insert into public.session_registrations (session_id, user_id, status)
  values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update
    set status = 'active', registered_at = now();

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'registered');

  delete from public.waitlist_requests where session_id = p_session_id and user_id = p_user_id;
  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.coach_add_athlete(uuid, uuid) to authenticated;

-- 4) Participant name exposure: athletes only see names for sessions they are participating in
create or replace function public.list_session_participants(p_session_id uuid)
returns table(full_name text, source text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_is_staff boolean;
  v_is_approved_athlete boolean;
  v_is_participant boolean;
begin
  if v_uid is null then
    return;
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return;
  end if;

  if coalesce(v_sess.is_hidden, false) then
    return;
  end if;

  v_is_staff := public.is_coach_or_manager(v_uid);
  v_is_approved_athlete := exists (
    select 1
    from public.profiles p
    where p.user_id = v_uid and p.role = 'athlete' and p.approval_status = 'approved'
  );

  if not (v_is_staff or v_is_approved_athlete) then
    return;
  end if;

  v_is_participant := exists (
    select 1
    from public.session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) or exists (
    select 1
    from public.waitlist_requests w
    where w.session_id = p_session_id and w.user_id = v_uid
  );

  if not v_is_staff and not v_is_participant then
    return;
  end if;

  return query
  select p.full_name, 'registered'::text
  from public.session_registrations r
  join public.profiles p on p.user_id = r.user_id
  where r.session_id = p_session_id and r.status = 'active'
  order by p.full_name;

  if v_is_staff then
    return query
    select mp.full_name, 'manual'::text
    from public.session_manual_participants smp
    join public.manual_participants mp on mp.id = smp.manual_participant_id
    where smp.session_id = p_session_id
    order by mp.full_name;
  end if;
end;
$$;

grant execute on function public.list_session_participants(uuid) to authenticated;

