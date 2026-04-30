-- Staff-only batch counts for waitlists.
-- Used for coach/manager calendar UI when a session is full.

create or replace function public.waitlist_counts(p_session_ids uuid[])
returns table(session_id uuid, n int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_coach_or_manager(v_uid) then
    raise exception 'forbidden';
  end if;

  return query
  with ids as (
    select unnest(p_session_ids) as session_id
  )
  select
    ids.session_id,
    coalesce(count(w.user_id), 0)::int as n
  from ids
  left join public.waitlist_requests w on w.session_id = ids.session_id
  group by ids.session_id;
end;
$$;

grant execute on function public.waitlist_counts(uuid[]) to authenticated;

