-- Kickbox rates are global tiers (session_capacity_pricing.is_kickbox), not per-athlete.

alter table public.session_capacity_pricing
  add column if not exists is_kickbox boolean not null default false;

comment on column public.session_capacity_pricing.is_kickbox is
  'False = standard studio tier; true = global kickbox tier for kickbox sessions.';

alter table public.session_capacity_pricing
  drop constraint if exists session_capacity_pricing_pkey;

alter table public.session_capacity_pricing
  add primary key (max_participants, is_kickbox);

-- Drop per-athlete kickbox overrides (replaced by global kickbox tiers).
delete from public.athlete_session_capacity_pricing where is_kickbox = true;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_pkey;

alter table public.athlete_session_capacity_pricing
  drop column if exists is_kickbox;

alter table public.athlete_session_capacity_pricing
  add primary key (user_id, max_participants);

drop index if exists athlete_session_capacity_pricing_kickbox_idx;

comment on column public.training_sessions.is_kickbox is
  'When true, billing uses global kickbox tiers (session_capacity_pricing.is_kickbox) before standard global tier.';

drop function if exists public.global_session_capacity_price_ils(int);

create or replace function public.global_session_capacity_price_ils(
  p_max_participants int,
  p_is_kickbox boolean default false
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
      limit 1
    ),
    0::numeric
  );
$$;

comment on function public.global_session_capacity_price_ils(int, boolean) is
  'Global studio tier price (standard or kickbox) for a session capacity.';

grant execute on function public.global_session_capacity_price_ils(int, boolean) to authenticated;

drop function if exists public.effective_session_price_ils(uuid, int, boolean);
drop function if exists public.effective_session_price_ils(uuid, int);

create or replace function public.effective_session_price_ils(
  p_user_id uuid,
  p_max_participants int,
  p_is_kickbox boolean default false
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p_is_kickbox, false) then
      public.global_session_capacity_price_ils(p_max_participants, true)
    else
      coalesce(
        (
          select o.price_ils
          from public.athlete_session_capacity_pricing o
          where o.user_id = p_user_id
            and o.max_participants = p_max_participants
          limit 1
        ),
        public.global_session_capacity_price_ils(p_max_participants, false)
      )
  end;
$$;

comment on function public.effective_session_price_ils(uuid, int, boolean) is
  'Kickbox sessions: global kickbox tier only. Standard sessions: athlete override else global tier.';

grant execute on function public.effective_session_price_ils(uuid, int, boolean) to authenticated;

create or replace function public.session_billing_price_ils(p_session_id uuid, p_user_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with sess as (
    select ts.custom_slot_price_ils, ts.max_participants, coalesce(ts.is_kickbox, false) as is_kickbox
    from public.training_sessions ts
    where ts.id = p_session_id
    limit 1
  )
  select coalesce(
    (select s.custom_slot_price_ils from sess s where s.custom_slot_price_ils is not null),
    case
      when p_user_id is not null then
        public.effective_session_price_ils(
          p_user_id,
          (select s.max_participants from sess s),
          (select s.is_kickbox from sess s)
        )
      else
        public.global_session_capacity_price_ils(
          (select s.max_participants from sess s),
          (select s.is_kickbox from sess s)
        )
    end,
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid) is
  'Session custom price, else resolved tier (kickbox global or standard athlete/global).';

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;
