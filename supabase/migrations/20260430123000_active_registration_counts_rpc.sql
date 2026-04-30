-- Batch counts for session capacity UI (athlete + staff).
-- RLS prevents athletes from reading other users' registrations directly, so counts must come from a security definer.

create or replace function public.active_registration_counts(p_session_ids uuid[])
returns table(session_id uuid, n int)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (
    select unnest(p_session_ids) as session_id
  ),
  reg as (
    select r.session_id, count(*)::int as n
    from public.session_registrations r
    join ids on ids.session_id = r.session_id
    where r.status = 'active'
    group by r.session_id
  ),
  man as (
    select m.session_id, count(*)::int as n
    from public.session_manual_participants m
    join ids on ids.session_id = m.session_id
    group by m.session_id
  )
  select
    ids.session_id,
    coalesce(reg.n, 0) + coalesce(man.n, 0) as n
  from ids
  left join reg on reg.session_id = ids.session_id
  left join man on man.session_id = ids.session_id;
$$;

grant execute on function public.active_registration_counts(uuid[]) to authenticated;

