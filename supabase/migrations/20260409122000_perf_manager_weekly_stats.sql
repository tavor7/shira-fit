-- Performance improvements for manager dashboard stats

-- Fast path: active registrations by session
create index if not exists session_registrations_session_active_idx
on public.session_registrations (session_id)
where status = 'active';

create index if not exists cancellations_session_idx
on public.cancellations (session_id);

create or replace function public.manager_weekly_stats(p_week_start date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_end date := p_week_start + 6;
  v_sessions int := 0;
  v_util_avg numeric := 0;
  v_cancels int := 0;
  v_no_show int := 0;
  v_pay jsonb := '{}'::jsonb;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  with sess as (
    select s.id, s.max_participants, s.session_date, s.start_time
    from public.training_sessions s
    where s.session_date between p_week_start and v_end
  ),
  reg as (
    select r.session_id, count(*)::int as n
    from public.session_registrations r
    join sess s on s.id = r.session_id
    where r.status = 'active'
    group by r.session_id
  ),
  man as (
    select m.session_id, count(*)::int as n
    from public.session_manual_participants m
    join sess s on s.id = m.session_id
    group by m.session_id
  ),
  counts as (
    select
      s.id,
      s.max_participants,
      coalesce(reg.n, 0) + coalesce(man.n, 0) as participants
    from sess s
    left join reg on reg.session_id = s.id
    left join man on man.session_id = s.id
  )
  select
    count(*)::int,
    coalesce(
      round(
        avg(
          least(
            1.0,
            greatest(
              0.0,
              (participants::numeric / nullif(max_participants, 0)::numeric)
            )
          )
        ) * 100,
        1
      ),
      0
    )
  into v_sessions, v_util_avg
  from counts;

  select count(*)::int into v_cancels
  from public.cancellations c
  join public.training_sessions s on s.id = c.session_id
  where s.session_date between p_week_start and v_end;

  -- No-show: active registration, session already started, explicitly marked absent.
  select count(*)::int into v_no_show
  from public.session_registrations reg
  join public.training_sessions s on s.id = reg.session_id
  where s.session_date between p_week_start and v_end
    and reg.status = 'active'
    and reg.attended = false
    and (s.session_date + s.start_time) < now();

  -- Payment method counts (arrived + recorded method) for regs + manual in range.
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_pay
  from (
    select k, sum(n)::int as n
    from (
      select
        coalesce(nullif(trim(reg.payment_method), ''), '(none)') as k,
        count(*)::int as n
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between p_week_start and v_end
        and reg.status = 'active'
        and reg.attended = true
      group by 1

      union all

      select
        coalesce(nullif(trim(m.payment_method), ''), '(none)') as k,
        count(*)::int as n
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between p_week_start and v_end
        and m.attended = true
      group by 1
    ) x
    group by k
  ) y;

  return json_build_object(
    'ok', true,
    'week_start', p_week_start,
    'week_end', v_end,
    'session_count', v_sessions,
    'utilization_avg_pct', v_util_avg,
    'cancellations', v_cancels,
    'no_shows', v_no_show,
    'payments_by_method', v_pay
  );
end;
$$;

grant execute on function public.manager_weekly_stats(date) to authenticated;

