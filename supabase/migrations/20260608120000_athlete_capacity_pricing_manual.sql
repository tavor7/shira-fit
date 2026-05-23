-- Personal rates for Quick Add (manual_participants) without an app account.

alter table public.athlete_session_capacity_pricing
  alter column user_id drop not null;

alter table public.athlete_session_capacity_pricing
  add column if not exists manual_participant_id uuid
    references public.manual_participants (id) on delete cascade;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_pkey;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_payee_chk check (
    (user_id is not null and manual_participant_id is null)
    or (user_id is null and manual_participant_id is not null)
  );

create unique index if not exists athlete_session_capacity_pricing_user_uidx
  on public.athlete_session_capacity_pricing (user_id, max_participants)
  where user_id is not null;

create unique index if not exists athlete_session_capacity_pricing_manual_uidx
  on public.athlete_session_capacity_pricing (manual_participant_id, max_participants)
  where manual_participant_id is not null;

create index if not exists athlete_session_capacity_pricing_manual_idx
  on public.athlete_session_capacity_pricing (manual_participant_id)
  where manual_participant_id is not null;

comment on column public.athlete_session_capacity_pricing.manual_participant_id is
  'Quick Add participant without app account; mutually exclusive with user_id.';

create or replace function public.participant_capacity_price_ils(
  p_user_id uuid,
  p_manual_participant_id uuid,
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
          where o.max_participants = p_max_participants
            and (
              (p_user_id is not null and o.user_id = p_user_id)
              or (
                p_manual_participant_id is not null
                and o.manual_participant_id = p_manual_participant_id
              )
            )
          limit 1
        ),
        public.global_session_capacity_price_ils(p_max_participants, false)
      )
  end;
$$;

comment on function public.participant_capacity_price_ils(uuid, uuid, int, boolean) is
  'Athlete or Quick Add manual override at a capacity tier, else global tier.';

grant execute on function public.participant_capacity_price_ils(uuid, uuid, int, boolean) to authenticated;

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
  select public.participant_capacity_price_ils(p_user_id, null, p_max_participants, p_is_kickbox);
$$;

grant execute on function public.effective_session_price_ils(uuid, int, boolean) to authenticated;

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
    select ts.custom_slot_price_ils, ts.max_participants, coalesce(ts.is_kickbox, false) as is_kickbox
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
      (select s.is_kickbox from sess s)
    ),
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid, uuid) is
  'Session custom price, else athlete/manual override, else global tier.';

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

comment on function public.session_billing_price_ils(uuid, uuid) is
  'Billing price for a registered athlete on a session (no manual participant).';

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;
