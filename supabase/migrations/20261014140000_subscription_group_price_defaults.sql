-- Default monthly subscription prices by weekly GROUP-session quota (1-4 per week), configured by managers.
--
-- Used only as a suggestion in the manager's "new subscription" form: when the subscription includes only group sessions
-- and the weekly group quota is 1-4, the configured default pre-fills the monthly price, which the manager can override.
-- It is never read by billing: a subscription's price is still the monthly_price_ils stored on its own version at
-- creation, so changing a default never touches existing subscriptions, charges or recurring billing. Quotas outside 1-4
-- (or mixed tiers) get no suggestion - nothing is invented. No price is seeded: the studio enters its own.
--
-- Manager-only (RLS for read and write); prices validated server-side (non-negative, two decimals, sane upper bound).

create table if not exists public.subscription_group_price_defaults (
  group_sessions_per_week smallint primary key
    constraint subscription_group_price_defaults_quota_chk check (group_sessions_per_week between 1 and 4),
  monthly_price_ils numeric(12, 2) not null
    constraint subscription_group_price_defaults_price_chk check (monthly_price_ils >= 0 and monthly_price_ils <= 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (user_id) on delete set null
);

comment on table public.subscription_group_price_defaults is
  'Suggested monthly price for a new subscription by weekly group-session quota (1-4). Suggestion only - never used by billing.';

drop trigger if exists subscription_group_price_defaults_updated on public.subscription_group_price_defaults;
create trigger subscription_group_price_defaults_updated
  before update on public.subscription_group_price_defaults
  for each row execute function public.set_updated_at();

create or replace function public._subscription_group_price_defaults_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke execute on function public._subscription_group_price_defaults_stamp() from public, anon, authenticated;

drop trigger if exists subscription_group_price_defaults_stamp on public.subscription_group_price_defaults;
create trigger subscription_group_price_defaults_stamp
  before insert or update on public.subscription_group_price_defaults
  for each row execute function public._subscription_group_price_defaults_stamp();

alter table public.subscription_group_price_defaults enable row level security;

drop policy if exists subscription_group_price_defaults_manager_all on public.subscription_group_price_defaults;
create policy subscription_group_price_defaults_manager_all on public.subscription_group_price_defaults
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

revoke all on table public.subscription_group_price_defaults from anon;
revoke all on table public.subscription_group_price_defaults from authenticated;
grant select, insert, update, delete on table public.subscription_group_price_defaults to authenticated;

do $$
begin
  if exists (select 1 from public.subscription_group_price_defaults) then
    raise exception 'self-check: no default price may be seeded';
  end if;
  if has_table_privilege('anon', 'public.subscription_group_price_defaults', 'SELECT')
     or has_table_privilege('authenticated', 'public.subscription_group_price_defaults', 'TRUNCATE') then
    raise exception 'self-check: unexpected privileges';
  end if;
end $$;
