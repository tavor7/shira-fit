-- Global per-session-capacity pricing (staff-managed) and athlete account payments (not tied to a session).

-- 1) Price for a practice when training_sessions.max_participants = N
create table if not exists public.session_capacity_pricing (
  max_participants int primary key check (max_participants > 0),
  price_ils numeric(12, 2) not null check (price_ils >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.session_capacity_pricing is
  'Global studio pricing: session with this max_participants capacity costs price_ils for billing expectations in reports.';

drop trigger if exists session_capacity_pricing_updated on public.session_capacity_pricing;
create trigger session_capacity_pricing_updated
  before update on public.session_capacity_pricing
  for each row execute function public.set_updated_at();

alter table public.session_capacity_pricing enable row level security;

drop policy if exists session_capacity_pricing_staff_select on public.session_capacity_pricing;
create policy session_capacity_pricing_staff_select on public.session_capacity_pricing
  for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_capacity_pricing_staff_write on public.session_capacity_pricing;
create policy session_capacity_pricing_staff_write on public.session_capacity_pricing
  for all
  using (public.is_coach_or_manager(auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()));

-- 2) Payments recorded for an athlete / quick-add person, not linked to a session
create table if not exists public.athlete_account_payments (
  id uuid primary key default gen_random_uuid(),
  payee_id uuid not null,
  payee_is_manual boolean not null default false,
  amount_ils numeric(12, 2) not null check (amount_ils > 0),
  payment_method text not null,
  note text,
  paid_at date not null default (timezone('UTC', now()))::date,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.athlete_account_payments is
  'Staff-recorded payment for an athlete (profiles.user_id) or manual_participants.id when payee_is_manual.';

create index if not exists athlete_account_payments_payee_idx
  on public.athlete_account_payments (payee_is_manual, payee_id, paid_at);

alter table public.athlete_account_payments enable row level security;

drop policy if exists athlete_account_payments_staff_select on public.athlete_account_payments;
create policy athlete_account_payments_staff_select on public.athlete_account_payments
  for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists athlete_account_payments_staff_write on public.athlete_account_payments;
create policy athlete_account_payments_staff_write on public.athlete_account_payments
  for all
  using (public.is_coach_or_manager(auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()));

create or replace function public._validate_athlete_account_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payee_is_manual then
    if not exists (select 1 from public.manual_participants mp where mp.id = new.payee_id) then
      raise exception 'invalid_manual_payee';
    end if;
  else
    if not exists (
      select 1 from public.profiles p
      where p.user_id = new.payee_id and p.role = 'athlete'
    ) then
      raise exception 'invalid_athlete_payee';
    end if;
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists athlete_account_payments_validate on public.athlete_account_payments;
create trigger athlete_account_payments_validate
  before insert on public.athlete_account_payments
  for each row execute function public._validate_athlete_account_payment();
