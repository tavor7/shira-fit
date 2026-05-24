-- Date-effective pricing: global, athlete/manual, and coach tiers with overlap protection.
-- Billing resolves rates using each session's session_date.

create extension if not exists btree_gist;

-- ---------- helpers ----------

create or replace function public.pricing_open_end(p_to date)
returns date
language sql
immutable
as $$
  select coalesce(p_to, '9999-12-31'::date);
$$;

create or replace function public.pricing_ranges_overlap(
  p_from_a date,
  p_to_a date,
  p_from_b date,
  p_to_b date
)
returns boolean
language sql
immutable
as $$
  select p_from_a <= public.pricing_open_end(p_to_b)
    and p_from_b <= public.pricing_open_end(p_to_a);
$$;

create or replace function public.pricing_active_on(
  p_effective_from date,
  p_effective_to date,
  p_as_of date
)
returns boolean
language sql
immutable
as $$
  select p_as_of >= p_effective_from
    and p_as_of <= public.pricing_open_end(p_effective_to);
$$;

-- ---------- session_capacity_pricing ----------

alter table public.session_capacity_pricing
  add column if not exists id uuid default gen_random_uuid();

alter table public.session_capacity_pricing
  add column if not exists effective_from date;

alter table public.session_capacity_pricing
  add column if not exists effective_to date;

update public.session_capacity_pricing
set
  effective_from = coalesce(effective_from, '2020-01-01'::date),
  effective_to = effective_to
where effective_from is null;

alter table public.session_capacity_pricing
  alter column effective_from set not null;

alter table public.session_capacity_pricing
  alter column effective_from set default current_date;

alter table public.session_capacity_pricing
  drop constraint if exists session_capacity_pricing_pkey;

alter table public.session_capacity_pricing
  alter column id set not null;

alter table public.session_capacity_pricing
  drop constraint if exists session_capacity_pricing_pkey;

alter table public.session_capacity_pricing
  add constraint session_capacity_pricing_pkey primary key (id);

alter table public.session_capacity_pricing
  drop constraint if exists session_capacity_pricing_dates_chk;

alter table public.session_capacity_pricing
  add constraint session_capacity_pricing_dates_chk check (
    effective_to is null or effective_to >= effective_from
  );

alter table public.session_capacity_pricing
  drop constraint if exists session_capacity_pricing_dates_excl;

alter table public.session_capacity_pricing
  add constraint session_capacity_pricing_dates_excl
  exclude using gist (
    max_participants with =,
    is_kickbox with =,
    daterange(effective_from, public.pricing_open_end(effective_to), '[]') with &&
  );

create index if not exists session_capacity_pricing_lookup_idx
  on public.session_capacity_pricing (max_participants, is_kickbox, effective_from desc);

-- ---------- athlete_session_capacity_pricing (incl. Quick Add manual) ----------

alter table public.athlete_session_capacity_pricing
  alter column user_id drop not null;

alter table public.athlete_session_capacity_pricing
  add column if not exists manual_participant_id uuid
    references public.manual_participants (id) on delete cascade;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_payee_chk;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_payee_chk check (
    (user_id is not null and manual_participant_id is null)
    or (user_id is null and manual_participant_id is not null)
  );

alter table public.athlete_session_capacity_pricing
  add column if not exists id uuid default gen_random_uuid();

alter table public.athlete_session_capacity_pricing
  add column if not exists effective_from date;

alter table public.athlete_session_capacity_pricing
  add column if not exists effective_to date;

update public.athlete_session_capacity_pricing
set
  effective_from = coalesce(effective_from, '2020-01-01'::date),
  effective_to = effective_to
where effective_from is null;

alter table public.athlete_session_capacity_pricing
  alter column effective_from set not null;

alter table public.athlete_session_capacity_pricing
  alter column effective_from set default current_date;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_pkey;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_user_uniq;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_manual_uniq;

alter table public.athlete_session_capacity_pricing
  alter column id set not null;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_pkey;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_pkey primary key (id);

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_dates_chk;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_dates_chk check (
    effective_to is null or effective_to >= effective_from
  );

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_user_dates_excl;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_user_dates_excl
  exclude using gist (
    user_id with =,
    max_participants with =,
    daterange(effective_from, public.pricing_open_end(effective_to), '[]') with &&
  )
  where (user_id is not null);

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_manual_dates_excl;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_manual_dates_excl
  exclude using gist (
    manual_participant_id with =,
    max_participants with =,
    daterange(effective_from, public.pricing_open_end(effective_to), '[]') with &&
  )
  where (manual_participant_id is not null);

create index if not exists athlete_session_capacity_pricing_user_lookup_idx
  on public.athlete_session_capacity_pricing (user_id, max_participants, effective_from desc)
  where user_id is not null;

create index if not exists athlete_session_capacity_pricing_manual_lookup_idx
  on public.athlete_session_capacity_pricing (manual_participant_id, max_participants, effective_from desc)
  where manual_participant_id is not null;

-- ---------- coach_capacity_pricing ----------

alter table public.coach_capacity_pricing
  add column if not exists id uuid default gen_random_uuid();

alter table public.coach_capacity_pricing
  add column if not exists effective_from date;

alter table public.coach_capacity_pricing
  add column if not exists effective_to date;

update public.coach_capacity_pricing
set
  effective_from = coalesce(effective_from, '2020-01-01'::date),
  effective_to = effective_to
where effective_from is null;

alter table public.coach_capacity_pricing
  alter column effective_from set not null;

alter table public.coach_capacity_pricing
  alter column effective_from set default current_date;

alter table public.coach_capacity_pricing
  drop constraint if exists coach_capacity_pricing_pkey;

alter table public.coach_capacity_pricing
  alter column id set not null;

alter table public.coach_capacity_pricing
  drop constraint if exists coach_capacity_pricing_pkey;

alter table public.coach_capacity_pricing
  add constraint coach_capacity_pricing_pkey primary key (id);

alter table public.coach_capacity_pricing
  drop constraint if exists coach_capacity_pricing_dates_chk;

alter table public.coach_capacity_pricing
  add constraint coach_capacity_pricing_dates_chk check (
    effective_to is null or effective_to >= effective_from
  );

alter table public.coach_capacity_pricing
  drop constraint if exists coach_capacity_pricing_dates_excl;

alter table public.coach_capacity_pricing
  add constraint coach_capacity_pricing_dates_excl
  exclude using gist (
    coach_id with =,
    max_participants with =,
    daterange(effective_from, public.pricing_open_end(effective_to), '[]') with &&
  );

create index if not exists coach_capacity_pricing_lookup_idx
  on public.coach_capacity_pricing (coach_id, max_participants, effective_from desc);

-- ---------- price resolution (session-date aware) ----------

drop function if exists public.global_session_capacity_price_ils(int);
drop function if exists public.global_session_capacity_price_ils(int, boolean);
drop function if exists public.global_session_capacity_price_ils(int, boolean, date);

create or replace function public.global_session_capacity_price_ils(
  p_max_participants int,
  p_is_kickbox boolean default false,
  p_as_of date default current_date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select g.price_ils
      from public.session_capacity_pricing g
      where g.max_participants = p_max_participants
        and g.is_kickbox = coalesce(p_is_kickbox, false)
        and public.pricing_active_on(g.effective_from, g.effective_to, p_as_of)
      order by g.effective_from desc
      limit 1
    ),
    0::numeric
  );
$$;

comment on function public.global_session_capacity_price_ils(int, boolean, date) is
  'Global studio tier active on p_as_of (standard or kickbox).';

grant execute on function public.global_session_capacity_price_ils(int, boolean, date) to authenticated;

drop function if exists public.participant_capacity_price_ils(uuid, uuid, int, boolean);
drop function if exists public.participant_capacity_price_ils(uuid, uuid, int, boolean, date);

create or replace function public.participant_capacity_price_ils(
  p_user_id uuid,
  p_manual_participant_id uuid,
  p_max_participants int,
  p_is_kickbox boolean default false,
  p_as_of date default current_date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p_is_kickbox, false) then
      public.global_session_capacity_price_ils(p_max_participants, true, p_as_of)
    else
      coalesce(
        (
          select o.price_ils
          from public.athlete_session_capacity_pricing o
          where o.max_participants = p_max_participants
            and public.pricing_active_on(o.effective_from, o.effective_to, p_as_of)
            and (
              (p_user_id is not null and o.user_id = p_user_id)
              or (
                p_manual_participant_id is not null
                and o.manual_participant_id = p_manual_participant_id
              )
            )
          order by o.effective_from desc
          limit 1
        ),
        public.global_session_capacity_price_ils(p_max_participants, false, p_as_of)
      )
  end;
$$;

comment on function public.participant_capacity_price_ils(uuid, uuid, int, boolean, date) is
  'Athlete or Quick Add override active on p_as_of, else global tier.';

grant execute on function public.participant_capacity_price_ils(uuid, uuid, int, boolean, date) to authenticated;

drop function if exists public.effective_session_price_ils(uuid, int);
drop function if exists public.effective_session_price_ils(uuid, int, boolean);
drop function if exists public.effective_session_price_ils(uuid, int, boolean, date);

create or replace function public.effective_session_price_ils(
  p_user_id uuid,
  p_max_participants int,
  p_is_kickbox boolean default false,
  p_as_of date default current_date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.participant_capacity_price_ils(p_user_id, null, p_max_participants, p_is_kickbox, p_as_of);
$$;

comment on function public.effective_session_price_ils(uuid, int, boolean, date) is
  'Studio price for athlete at capacity tier on p_as_of.';

grant execute on function public.effective_session_price_ils(uuid, int, boolean, date) to authenticated;

-- Must drop first: SQL-editor version may use different parameter names (e.g. p_max_participants).
drop function if exists public.coach_capacity_price_ils(uuid, int, date);
drop function if exists public.coach_capacity_price_ils(uuid, integer, date);

create or replace function public.coach_capacity_price_ils(
  p_coach_id uuid,
  p_registered_tier int,
  p_as_of date default current_date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.price_ils
      from public.coach_capacity_pricing p
      where p.coach_id = p_coach_id
        and p.max_participants = p_registered_tier
        and public.pricing_active_on(p.effective_from, p.effective_to, p_as_of)
      order by p.effective_from desc
      limit 1
    ),
    0::numeric
  );
$$;

comment on function public.coach_capacity_price_ils(uuid, int, date) is
  'Coach flat payout for registered headcount tier active on p_as_of.';

grant execute on function public.coach_capacity_price_ils(uuid, int, date) to authenticated;

drop function if exists public.session_billing_price_ils(uuid, uuid);
drop function if exists public.session_billing_price_ils(uuid, uuid, uuid);

create or replace function public.session_billing_price_ils(
  p_session_id uuid,
  p_user_id uuid,
  p_manual_participant_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with sess as (
    select
      ts.custom_slot_price_ils,
      ts.max_participants,
      coalesce(ts.is_kickbox, false) as is_kickbox,
      ts.session_date
    from public.training_sessions ts
    where ts.id = p_session_id
    limit 1
  )
  select coalesce(
    (select s.custom_slot_price_ils from sess s where s.custom_slot_price_ils is not null),
    public.participant_capacity_price_ils(
      p_user_id,
      p_manual_participant_id,
      (select s.max_participants from sess s),
      (select s.is_kickbox from sess s),
      (select s.session_date from sess s)
    ),
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid, uuid) is
  'Session custom price, else athlete/manual/global tier for session date.';

grant execute on function public.session_billing_price_ils(uuid, uuid, uuid) to authenticated;

create or replace function public.session_billing_price_ils(
  p_session_id uuid,
  p_user_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.session_billing_price_ils(p_session_id, p_user_id, null::uuid);
$$;

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;

-- ---------- cancellation penalty uses session date ----------

create or replace function public.manager_set_cancellation_penalty_collected(
  p_cancellation_id uuid,
  p_collected_ils numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  s_row training_sessions%rowtype;
  v_price numeric(12, 2);
  v_amt numeric(12, 2);
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_collected_ils is null or p_collected_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if c_row.charged_full_price is not true then
    return json_build_object('ok', false, 'error', 'not_chargeable');
  end if;

  select * into s_row from public.training_sessions where id = c_row.session_id;
  v_price := round(
    public.effective_session_price_ils(
      c_row.user_id,
      s_row.max_participants,
      coalesce(s_row.is_kickbox, false),
      s_row.session_date
    )::numeric,
    2
  )::numeric(12, 2);
  if v_price is null then v_price := 0; end if;

  v_amt := least(round(p_collected_ils::numeric, 2), v_price)::numeric(12, 2);

  update public.cancellations
  set penalty_collected_ils = v_amt
  where id = p_cancellation_id;

  return json_build_object('ok', true);
end;
$$;

-- ---------- coach sessions report ----------

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
        when (t.reg_n + t.man_n) > 0 then
          public.coach_capacity_price_ils(p_coach_id, (t.reg_n + t.man_n), s.session_date)
        else 0::numeric
      end
    ) as coach_earnings_ils,
    (
      (t.reg_n + t.man_n) > 0
      and public.coach_capacity_price_ils(p_coach_id, (t.reg_n + t.man_n), s.session_date) = 0
    ) as coach_rate_missing
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
