-- Coach sessions report:
--   registered_count = active session_registrations + session_manual_participants (quick-add).
--   Pick coach_capacity_pricing row where max_participants = registered_count (tier = exact headcount).
--   coach_earnings_ils = that row's price_ils (flat session total), not multiplied by count.
--   Session training max_participants and arrived counts do not change the tier or amount.

comment on table public.coach_capacity_pricing is
  'Per coach: flat session payout (₪) when registered headcount (app + quick-add) exactly equals max_participants on this row.';

drop function if exists public.manager_coach_sessions_report(date, date, uuid);

create or replace function public.manager_coach_sessions_report(
  p_start date,
  p_end date,
  p_coach_id uuid
)
returns table (
  session_id uuid,
  session_date date,
  start_time time,
  duration_minutes int,
  registered_count int,
  arrived_count int,
  late_cancellations_within_24h int,
  max_participants int,
  coach_earnings_ils numeric,
  coach_rate_missing boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  return query
  select
    s.id,
    s.session_date,
    s.start_time,
    coalesce(s.duration_minutes, 60)::int,
    (t.reg_n + t.man_n)::int,
    (ac.cnt + am.cnt)::int,
    lc.cnt,
    s.max_participants,
    (
      case
        when (t.reg_n + t.man_n) > 0 then coalesce(p.price_ils, 0)::numeric
        else 0::numeric
      end
    ) as coach_earnings_ils,
    (p.coach_id is null and (t.reg_n + t.man_n) > 0) as coach_rate_missing
  from public.training_sessions s
  cross join lateral (
    select
      coalesce((
        select count(*)::int
        from public.session_registrations r
        where r.session_id = s.id and r.status = 'active'
      ), 0) as reg_n,
      coalesce((
        select count(*)::int
        from public.session_manual_participants smp
        where smp.session_id = s.id
      ), 0) as man_n
  ) t
  left join public.coach_capacity_pricing p
    on p.coach_id = p_coach_id
    and p.max_participants = (t.reg_n + t.man_n)
  cross join lateral (
    select count(*)::int as cnt
    from public.session_registrations r
    where r.session_id = s.id and r.status = 'active' and r.attended is true
  ) ac
  cross join lateral (
    select count(*)::int as cnt
    from public.session_manual_participants smp
    where smp.session_id = s.id and smp.attended is true
  ) am
  cross join lateral (
    select count(*)::int as cnt
    from public.cancellations c
    where c.session_id = s.id and c.charged_full_price is true
  ) lc
  where s.coach_id = p_coach_id
    and s.session_date >= p_start
    and s.session_date <= p_end
  order by s.session_date desc, s.start_time desc;
end;
$$;

grant execute on function public.manager_coach_sessions_report(date, date, uuid) to authenticated;
