-- Athletes should be able to see participant names on session detail even if not registered.
-- Keep hidden sessions protected; require approved athlete or staff.

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
begin
  if v_uid is null then
    return;
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return;
  end if;

  -- Don't expose hidden sessions to athlete browse flows.
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

  return query
  select p.full_name, 'registered'::text
  from public.session_registrations r
  join public.profiles p on p.user_id = r.user_id
  where r.session_id = p_session_id and r.status = 'active'
  order by p.full_name;

  -- Manual participants are staff-only; expose only to staff.
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

