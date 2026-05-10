-- Per-athlete overrides for global session_capacity_pricing (same tier key: max_participants).

create table if not exists public.athlete_session_capacity_pricing (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  max_participants int not null check (max_participants > 0),
  price_ils numeric(12, 2) not null check (price_ils >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, max_participants)
);

comment on table public.athlete_session_capacity_pricing is
  'Studio session price override for a specific athlete at a capacity tier; falls back to session_capacity_pricing when missing.';

drop trigger if exists athlete_session_capacity_pricing_updated on public.athlete_session_capacity_pricing;
create trigger athlete_session_capacity_pricing_updated
  before update on public.athlete_session_capacity_pricing
  for each row execute function public.set_updated_at();

alter table public.athlete_session_capacity_pricing enable row level security;

drop policy if exists athlete_session_capacity_pricing_staff_select on public.athlete_session_capacity_pricing;
create policy athlete_session_capacity_pricing_staff_select on public.athlete_session_capacity_pricing
  for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists athlete_session_capacity_pricing_staff_write on public.athlete_session_capacity_pricing;
create policy athlete_session_capacity_pricing_staff_write on public.athlete_session_capacity_pricing
  for all
  using (public.is_coach_or_manager(auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()));

create index if not exists athlete_session_capacity_pricing_user_idx
  on public.athlete_session_capacity_pricing (user_id);

-- Effective studio slot price (late cancel / no-show cap): athlete override, else global tier.
create or replace function public.effective_session_price_ils(p_user_id uuid, p_max_participants int)
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
      limit 1
    ),
    (
      select g.price_ils
      from public.session_capacity_pricing g
      where g.max_participants = p_max_participants
      limit 1
    ),
    0::numeric
  );
$$;

comment on function public.effective_session_price_ils(uuid, int) is
  'Studio price for an athlete at a session capacity tier: athlete_session_capacity_pricing override or session_capacity_pricing.';

grant execute on function public.effective_session_price_ils(uuid, int) to authenticated;

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
  v_price := round(public.effective_session_price_ils(c_row.user_id, s_row.max_participants)::numeric, 2)::numeric(12, 2);
  if v_price is null then v_price := 0; end if;

  v_amt := least(round(p_collected_ils::numeric, 2), v_price)::numeric(12, 2);

  update public.cancellations
  set penalty_collected_ils = v_amt
  where id = p_cancellation_id;

  return json_build_object('ok', true);
end;
$$;
