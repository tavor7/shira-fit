-- Role-aware headcount for staff calendar cards, distinct from
-- active_registration_counts (which stays real everywhere it's used for
-- capacity enforcement — registration limits, waitlist eligibility, athlete
-- "spots left"). A coach/manager viewing their own session list should see a
-- count that matches what they can actually see in the roster: excluding
-- athletes hidden from their specific role. Super User always sees the real
-- count. Manual (walk-in) participants are unaffected by hiding.

create or replace function public.visible_registration_counts(p_session_ids uuid[])
returns table(session_id uuid, n int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_super boolean;
  v_is_manager boolean;
  v_is_coach boolean;
begin
  v_is_super := public.is_super_user(v_uid);
  v_is_manager := public.is_manager(v_uid);
  v_is_coach := public.is_coach(v_uid);

  return query
  with ids as (
    select unnest(p_session_ids) as session_id
  ),
  reg as (
    select r.session_id, count(*)::int as n
    from public.session_registrations r
    join ids on ids.session_id = r.session_id
    where r.status = 'active'
      and (
        v_is_super
        or (v_is_manager and not public.is_registration_hidden_from_manager(r.session_id, r.user_id))
        or (v_is_coach and not public.is_registration_hidden_from_coach(r.session_id, r.user_id))
        or (not v_is_manager and not v_is_coach)
      )
    group by r.session_id
  ),
  man as (
    select smp.session_id, count(*)::int as n
    from public.session_manual_participants smp
    join public.manual_participants mp on mp.id = smp.manual_participant_id
    join ids on ids.session_id = smp.session_id
    where mp.linked_user_id is null
       or not exists (
         select 1
         from public.session_registrations r2
         where r2.session_id = smp.session_id
           and r2.user_id = mp.linked_user_id
           and r2.status = 'active'
       )
    group by smp.session_id
  )
  select
    ids.session_id,
    coalesce(reg.n, 0) + coalesce(man.n, 0) as n
  from ids
  left join reg on reg.session_id = ids.session_id
  left join man on man.session_id = ids.session_id;
end;
$$;

grant execute on function public.visible_registration_counts(uuid[]) to authenticated;
