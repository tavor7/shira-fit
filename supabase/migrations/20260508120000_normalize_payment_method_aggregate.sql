-- Combine payment counts across Hebrew / English / casing variants for manager_weekly_stats.

create or replace function public.normalize_payment_method_key(p text)
returns text
language plpgsql
immutable
set search_path to public, pg_temp
as $$
declare
  t text := btrim(p);
  tl text;
begin
  if t is null or t = '' then
    return '(none)';
  end if;

  tl := lower(t);

  if tl in ('(none)', 'none', 'n/a', 'na', 'unspecified', 'unpaid', '-', '—') then
    return '(none)';
  end if;

  -- Cash (English + Hebrew UI strings)
  if tl = 'cash' or t in ('Cash', 'CASH', 'מזומן') then
    return 'cash';
  end if;

  -- PayBox brand / Hebrew label if ever stored
  if tl in ('paybox', 'pay box', 'pay-box') or t in ('PayBox', 'PAYBOX', 'פייבוקס') then
    return 'paybox';
  end if;

  -- Other
  if tl = 'other' or t in ('Other', 'OTHER', 'אחר') then
    return 'other';
  end if;

  -- Custom labels (rare): keep as-is so identical spellings still aggregate together
  return t;
end;
$$;

comment on function public.normalize_payment_method_key(text) is
  'Maps payment_method raw values to stable keys (cash, paybox, other, (none)) for reporting.';

create or replace function public.manager_weekly_stats(p_week_start date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week_start date := public._week_start_sunday(p_week_start);
  v_end date := v_week_start + 6;
  v_sessions int := 0;
  v_util_avg numeric := 0;
  v_cancels int := 0;
  v_no_show int := 0;
  v_wait int := 0;
  v_checked_in int := 0;
  v_pay jsonb := '{}'::jsonb;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  with sess as (
    select s.id, s.max_participants, s.session_date, s.start_time
    from public.training_sessions s
    where s.session_date between v_week_start and v_end
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
  where s.session_date between v_week_start and v_end;

  select count(*)::int into v_no_show
  from public.session_registrations reg
  join public.training_sessions s on s.id = reg.session_id
  where s.session_date between v_week_start and v_end
    and reg.status = 'active'
    and reg.attended = false
    and (s.session_date + s.start_time) < now();

  select count(*)::int into v_wait
  from public.waitlist_requests w
  join public.training_sessions s on s.id = w.session_id
  where s.session_date between v_week_start and v_end;

  select
    (select count(*)::int
     from public.session_registrations reg
     join public.training_sessions s on s.id = reg.session_id
     where s.session_date between v_week_start and v_end
       and reg.status = 'active'
       and reg.attended = true)
    +
    (select count(*)::int
     from public.session_manual_participants m
     join public.training_sessions s on s.id = m.session_id
     where s.session_date between v_week_start and v_end
       and m.attended = true)
  into v_checked_in;

  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_pay
  from (
    select k, sum(n)::int as n
    from (
      select
        public.normalize_payment_method_key(reg.payment_method) as k,
        count(*)::int as n
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_week_start and v_end
        and reg.status = 'active'
      group by 1

      union all

      select
        public.normalize_payment_method_key(m.payment_method) as k,
        count(*)::int as n
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_week_start and v_end
      group by 1
    ) x
    group by k
  ) y;

  return json_build_object(
    'ok', true,
    'week_start', v_week_start,
    'week_end', v_end,
    'session_count', v_sessions,
    'utilization_avg_pct', v_util_avg,
    'cancellations', v_cancels,
    'no_shows', v_no_show,
    'waitlist_count', v_wait,
    'checked_in_count', v_checked_in,
    'payments_by_method', v_pay
  );
end;
$$;

grant execute on function public.manager_weekly_stats(date) to authenticated;
