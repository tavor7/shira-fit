-- Capacity mismatch: include quick-add (session_manual_participants) in registered headcount.
-- Deduplicate when a linked quick-add also has an active app registration.

create or replace function public.active_registration_count(sid uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((
      select count(*)::int
      from public.session_registrations r
      where r.session_id = sid and r.status = 'active'
    ), 0)
    +
    coalesce((
      select count(*)::int
      from public.session_manual_participants smp
      join public.manual_participants mp on mp.id = smp.manual_participant_id
      where smp.session_id = sid
        and (
          mp.linked_user_id is null
          or not exists (
            select 1
            from public.session_registrations r2
            where r2.session_id = sid
              and r2.user_id = mp.linked_user_id
              and r2.status = 'active'
          )
        )
    ), 0);
$$;

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
$$;

-- Re-apply latest manager_capacity_mismatch (uses active_registration_count).
create or replace function public.manager_capacity_mismatch(p_anchor date, p_mode text default 'week')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_start date;
  v_end date;
  v_result json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month', 'global') then
    v_mode := 'week';
  end if;

  select b.period_start, b.period_end into v_start, v_end
  from public._manager_stats_period_bounds(p_anchor, v_mode) b;

  select json_build_object(
    'ok', true,
    'week_start', v_start,
    'week_end', v_end,
    'count', coalesce(count(*)::int, 0),
    'sessions', coalesce(
      json_agg(
        json_build_object(
          'session_id', x.session_id,
          'session_date', x.session_date,
          'start_time', x.start_time::text,
          'duration_minutes', x.duration_minutes,
          'coach_name', x.coach_name,
          'max_participants', x.max_participants,
          'registered_count', x.registered_count
        )
        order by x.session_date asc, x.start_time asc
      ),
      '[]'::json
    )
  )
  into v_result
  from (
    select
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      pr.full_name as coach_name,
      s.max_participants,
      public.active_registration_count(s.id) as registered_count
    from public.training_sessions s
    left join public.profiles pr on pr.user_id = s.coach_id
    where s.session_date between v_start and v_end
      and s.max_participants < 12
      and public._session_has_ended(s)
      and public.active_registration_count(s.id) <> s.max_participants
  ) x;

  return v_result;
end;
$$;

grant execute on function public.active_registration_count(uuid) to authenticated;
grant execute on function public.active_registration_counts(uuid[]) to authenticated;
grant execute on function public.manager_capacity_mismatch(date, text) to authenticated;
