-- list_session_participants is security definer (bypasses RLS) and does its
-- own authorization, so the RLS hide-filter from 20260829120000 doesn't reach
-- it. Patch the 'registered' branch so a hidden athlete's name never appears
-- to non-staff callers (including the hidden athlete's own self-participant
-- check), while staff keep seeing the real, unfiltered roster.

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
      and not public.is_registration_hidden(r.session_id, r.user_id)
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
    and (v_is_staff or not public.is_registration_hidden(r.session_id, r.user_id))
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
