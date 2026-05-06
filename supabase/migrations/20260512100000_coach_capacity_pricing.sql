-- Per-coach payment rates by session max capacity (used in manager coach sessions report).

create table if not exists public.coach_capacity_pricing (
  coach_id uuid not null references public.profiles (user_id) on delete cascade,
  max_participants int not null check (max_participants > 0),
  price_ils numeric(12, 2) not null check (price_ils >= 0),
  updated_at timestamptz not null default now(),
  primary key (coach_id, max_participants)
);

comment on table public.coach_capacity_pricing is
  'Coach payment per arrived participant for sessions with this max_participants. Report total = sum(arrived_count * price_ils) per session.';

drop trigger if exists coach_capacity_pricing_updated on public.coach_capacity_pricing;
create trigger coach_capacity_pricing_updated
  before update on public.coach_capacity_pricing
  for each row execute function public.set_updated_at();

alter table public.coach_capacity_pricing enable row level security;

drop policy if exists coach_capacity_pricing_select on public.coach_capacity_pricing;
create policy coach_capacity_pricing_select on public.coach_capacity_pricing
  for select using (
    public.is_manager(auth.uid())
    or coach_id = auth.uid()
  );

drop policy if exists coach_capacity_pricing_insert on public.coach_capacity_pricing;
create policy coach_capacity_pricing_insert on public.coach_capacity_pricing
  for insert
  with check (
    public.is_manager(auth.uid())
    or (
      coach_id = auth.uid()
      and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    )
  );

drop policy if exists coach_capacity_pricing_update on public.coach_capacity_pricing;
create policy coach_capacity_pricing_update on public.coach_capacity_pricing
  for update
  using (
    public.is_manager(auth.uid())
    or (
      coach_id = auth.uid()
      and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    )
  )
  with check (
    public.is_manager(auth.uid())
    or (
      coach_id = auth.uid()
      and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    )
  );

drop policy if exists coach_capacity_pricing_delete on public.coach_capacity_pricing;
create policy coach_capacity_pricing_delete on public.coach_capacity_pricing
  for delete using (
    public.is_manager(auth.uid())
    or (
      coach_id = auth.uid()
      and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    )
  );

-- Coach sessions report: include capacity, computed coach earnings, missing-rate flag
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
    rc.cnt,
    ac.cnt,
    lc.cnt,
    s.max_participants,
    (ac.cnt::numeric * coalesce(p.price_ils, 0)) as coach_earnings_ils,
    (p.coach_id is null and ac.cnt > 0) as coach_rate_missing
  from public.training_sessions s
  left join public.coach_capacity_pricing p
    on p.coach_id = p_coach_id
    and p.max_participants = s.max_participants
  cross join lateral (
    select count(*)::int as cnt
    from public.session_registrations r
    where r.session_id = s.id and r.status = 'active'
  ) rc
  cross join lateral (
    select count(*)::int as cnt
    from public.session_registrations r
    where r.session_id = s.id and r.status = 'active' and r.attended is true
  ) ac
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
