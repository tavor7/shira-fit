-- Kickbox sessions: flag on training_sessions + per-athlete kickbox rates at capacity tiers.

alter table public.training_sessions
  add column if not exists is_kickbox boolean not null default false;

comment on column public.training_sessions.is_kickbox is
  'When true, billing uses athlete kickbox rates (athlete_session_capacity_pricing.is_kickbox) before global tier.';

alter table public.athlete_session_capacity_pricing
  add column if not exists is_kickbox boolean not null default false;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_pkey;

alter table public.athlete_session_capacity_pricing
  add primary key (user_id, max_participants, is_kickbox);

comment on column public.athlete_session_capacity_pricing.is_kickbox is
  'False = standard athlete override; true = kickbox athlete override for kickbox sessions.';

create index if not exists athlete_session_capacity_pricing_kickbox_idx
  on public.athlete_session_capacity_pricing (user_id, is_kickbox)
  where is_kickbox = true;

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
  select coalesce(
    (
      select o.price_ils
      from public.athlete_session_capacity_pricing o
      where o.user_id = p_user_id
        and o.max_participants = p_max_participants
        and o.is_kickbox = coalesce(p_is_kickbox, false)
      limit 1
    ),
    public.global_session_capacity_price_ils(p_max_participants)
  );
$$;

comment on function public.effective_session_price_ils(uuid, int, boolean) is
  'Athlete rate (standard or kickbox) at capacity tier, else global tier.';

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
        public.global_session_capacity_price_ils((select s.max_participants from sess s))
    end,
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid) is
  'Session custom price, else athlete rate (kickbox or standard), else global tier.';

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;
