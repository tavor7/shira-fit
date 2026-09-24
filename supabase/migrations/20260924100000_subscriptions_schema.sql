-- Subscription Management — Phase 1: schema + core helpers.
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md for the approved architecture.
--
-- Adds recurring subscriptions as an additional entitlement/billing layer on top of the
-- existing pay-per-session system. "Expected debt" stays computed live by
-- _period_merged_athlete_finance(); a subscription only changes that computation via
-- (a) a per-registration `covered` flag that zeroes out the session's own expected price,
-- and (b) subscription_charges rows unioned in as additional expected-amount line items.
--
-- Phase 1 scope: tables, enums, helpers, and the finance-function extension only.
-- No CRUD RPCs, no billing cron, no atomic registration wiring (that is Phase 2/3, separate
-- migrations) — this migration only lays the schema + read-only helpers.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.subscription_tier as enum (
    'personal', 'pair', 'trio', 'quartet', 'quintet', 'sextet', 'group'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.subscription_charge_type as enum (
    'recurring', 'proration', 'freeze_credit', 'stop_proration', 'reversal'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.subscription_non_coverage_reason as enum (
    'not_subscribed', 'tier_not_included', 'frozen', 'allowance_exceeded'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.subscription_impact_action_type as enum (
    'freeze', 'stop', 'edit', 'reactivate'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 1. subscriptions — stable identity per subscription lineage.
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  payee_id uuid not null,
  payee_is_manual boolean not null default false,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

comment on table public.subscriptions is
  'Recurring-subscription lineage identity. deleted_at is a tombstone (see plan §Delete) — '
  'never a hard delete; charges/coverage referencing this id must keep working after tombstoning.';
comment on column public.subscriptions.payee_id is
  'profiles.user_id when payee_is_manual = false, else manual_participants.id. Same dual-payee '
  'convention as athlete_account_payments (payee_id + payee_is_manual flag), validated by trigger below.';

create index if not exists subscriptions_payee_idx
  on public.subscriptions (payee_is_manual, payee_id)
  where deleted_at is null;

-- Validate payee_id refers to a real athlete/coach profile or manual participant, same pattern
-- as public._validate_athlete_account_payment().
create or replace function public._validate_subscription_payee()
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
      where p.user_id = new.payee_id and p.role in ('athlete', 'coach')
    ) then
      raise exception 'invalid_athlete_payee';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_validate_payee on public.subscriptions;
create trigger subscriptions_validate_payee
  before insert or update of payee_id, payee_is_manual on public.subscriptions
  for each row execute function public._validate_subscription_payee();

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_manager_all on public.subscriptions;
create policy subscriptions_manager_all on public.subscriptions
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. subscription_versions — configurable settings, versioned per edit.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_versions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  version_no int not null,
  effective_from date not null,
  effective_to date null,
  monthly_price_ils numeric(12, 2) not null check (monthly_price_ils >= 0),
  anchor_day smallint not null check (anchor_day between 1 and 31),
  plan_start_date date not null,
  plan_end_date date null,
  is_unlimited boolean not null default false,
  stopped_effective_date date null,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_by uuid null references public.subscription_versions (id) on delete set null,
  constraint subscription_versions_dates_chk check (effective_to is null or effective_to > effective_from),
  constraint subscription_versions_plan_dates_chk check (plan_end_date is null or plan_end_date >= plan_start_date),
  constraint subscription_versions_version_no_uniq unique (subscription_id, version_no)
);

comment on table public.subscription_versions is
  'No persisted status enum — lifecycle is derived on demand by subscription_version_display_status(). '
  'Only stopped_effective_date and effective_to/superseded_by are stored facts.';

-- Only one "current" (open-ended) version per subscription.
create unique index if not exists subscription_versions_current_uidx
  on public.subscription_versions (subscription_id)
  where effective_to is null;

create index if not exists subscription_versions_subscription_idx
  on public.subscription_versions (subscription_id, effective_from);

alter table public.subscription_versions enable row level security;

drop policy if exists subscription_versions_manager_all on public.subscription_versions;
create policy subscription_versions_manager_all on public.subscription_versions
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. subscription_version_allowances — per-tier weekly limit for a version.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_version_allowances (
  version_id uuid not null references public.subscription_versions (id) on delete cascade,
  tier public.subscription_tier not null,
  weekly_limit int not null check (weekly_limit >= 0),
  primary key (version_id, tier)
);

alter table public.subscription_version_allowances enable row level security;

drop policy if exists subscription_version_allowances_manager_all on public.subscription_version_allowances;
create policy subscription_version_allowances_manager_all on public.subscription_version_allowances
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. subscription_freezes — sole source of truth for freeze periods.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_freezes (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  freeze_from date not null,
  freeze_until date not null,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz null,
  constraint subscription_freezes_dates_chk check (freeze_until >= freeze_from)
);

-- Non-overlapping active freezes per subscription (cancelled freezes are excluded).
alter table public.subscription_freezes
  drop constraint if exists subscription_freezes_no_overlap_excl;
alter table public.subscription_freezes
  add constraint subscription_freezes_no_overlap_excl
  exclude using gist (
    subscription_id with =,
    daterange(freeze_from, freeze_until, '[]') with &&
  )
  where (cancelled_at is null);

create index if not exists subscription_freezes_subscription_idx
  on public.subscription_freezes (subscription_id)
  where cancelled_at is null;

alter table public.subscription_freezes enable row level security;

drop policy if exists subscription_freezes_manager_all on public.subscription_freezes;
create policy subscription_freezes_manager_all on public.subscription_freezes
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. subscription_billing_periods — explicit billing-period identity.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_billing_periods (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  version_id uuid not null references public.subscription_versions (id) on delete restrict,
  period_start date not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  constraint subscription_billing_periods_dates_chk check (period_end > period_start),
  constraint subscription_billing_periods_period_uniq unique (subscription_id, period_start)
);

create index if not exists subscription_billing_periods_subscription_idx
  on public.subscription_billing_periods (subscription_id, period_start);

alter table public.subscription_billing_periods enable row level security;

drop policy if exists subscription_billing_periods_manager_all on public.subscription_billing_periods;
create policy subscription_billing_periods_manager_all on public.subscription_billing_periods
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 6. subscription_charges — immutable ledger, feeds the finance function.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_charges (
  id uuid primary key default gen_random_uuid(),
  billing_period_id uuid not null references public.subscription_billing_periods (id) on delete restrict,
  subscription_id uuid null references public.subscriptions (id) on delete set null,
  payee_id uuid not null,
  payee_is_manual boolean not null default false,
  amount_ils numeric(12, 2) not null,
  charge_type public.subscription_charge_type not null,
  reverses uuid null references public.subscription_charges (id) on delete restrict,
  source_event_id uuid null,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now()
);

comment on column public.subscription_charges.subscription_id is
  'Nullable so a charge''s financial meaning survives if the subscription is later tombstoned.';
comment on column public.subscription_charges.payee_id is
  'Denormalized from subscriptions.payee_id at charge-creation time — survives tombstoning.';
comment on column public.subscription_charges.source_event_id is
  'Idempotency anchor for correction charges (freeze id / stopped version id / retroactive-edit '
  'version id). Guarded by subscription_charges_source_event_uidx below.';

-- Exactly one "original" charge per billing period, regardless of proration.
create unique index if not exists subscription_charges_original_per_period_uidx
  on public.subscription_charges (billing_period_id)
  where charge_type in ('recurring', 'proration');

-- Idempotency guard for correction charges (stop/freeze/retroactive-edit reversal+correction).
create unique index if not exists subscription_charges_source_event_uidx
  on public.subscription_charges (source_event_id, charge_type)
  where source_event_id is not null;

create index if not exists subscription_charges_payee_idx
  on public.subscription_charges (payee_is_manual, payee_id);

create index if not exists subscription_charges_billing_period_idx
  on public.subscription_charges (billing_period_id);

alter table public.subscription_charges enable row level security;

drop policy if exists subscription_charges_manager_all on public.subscription_charges;
create policy subscription_charges_manager_all on public.subscription_charges
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 7. subscription_registration_coverage — per-registration entitlement decision.
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_registration_coverage (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  version_id uuid null references public.subscription_versions (id) on delete set null,
  registration_id uuid null references public.session_registrations (id) on delete cascade,
  manual_participant_id uuid null references public.session_manual_participants (id) on delete cascade,
  session_date date not null,
  week_start date not null,
  tier public.subscription_tier not null,
  covered boolean not null,
  non_coverage_reason public.subscription_non_coverage_reason null,
  decided_at timestamptz not null default now(),
  decided_by text not null check (decided_by in ('registration', 'reconcile')),
  constraint subscription_registration_coverage_payee_chk check (
    (registration_id is not null and manual_participant_id is null)
    or (registration_id is null and manual_participant_id is not null)
  ),
  constraint subscription_registration_coverage_reason_chk check (
    (covered = true and non_coverage_reason is null)
    or (covered = false and non_coverage_reason is not null)
  )
);

comment on column public.subscription_registration_coverage.manual_participant_id is
  'References session_manual_participants.id (the per-session participation row), not '
  'manual_participants.id, matching the plan''s field list exactly.';
comment on column public.subscription_registration_coverage.version_id is
  'The version effective for this session''s date when this decision was made (audit trail).';

create unique index if not exists subscription_registration_coverage_registration_uidx
  on public.subscription_registration_coverage (registration_id)
  where registration_id is not null;

create unique index if not exists subscription_registration_coverage_manual_uidx
  on public.subscription_registration_coverage (manual_participant_id)
  where manual_participant_id is not null;

create index if not exists subscription_registration_coverage_lookup_idx
  on public.subscription_registration_coverage (subscription_id, tier, week_start);

alter table public.subscription_registration_coverage enable row level security;

drop policy if exists subscription_registration_coverage_manager_all on public.subscription_registration_coverage;
create policy subscription_registration_coverage_manager_all on public.subscription_registration_coverage
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- 8. subscription_impact_events / subscription_impact_event_registrations
--    (audit tables for Phase 4's preview/confirm RPCs — schema only in this phase).
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_impact_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  action_type public.subscription_impact_action_type not null,
  action_source_id uuid not null,
  effective_date date not null,
  confirmed boolean not null default false,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now()
);

-- Idempotency lookup key for "same confirmed action retried" (Phase 4 reads this before writing).
create unique index if not exists subscription_impact_events_source_uidx
  on public.subscription_impact_events (subscription_id, action_type, action_source_id);

alter table public.subscription_impact_events enable row level security;

drop policy if exists subscription_impact_events_manager_all on public.subscription_impact_events;
create policy subscription_impact_events_manager_all on public.subscription_impact_events
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

create table if not exists public.subscription_impact_event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.subscription_impact_events (id) on delete cascade,
  registration_id uuid null references public.session_registrations (id) on delete cascade,
  manual_participant_id uuid null references public.session_manual_participants (id) on delete cascade,
  previous_covered boolean not null,
  new_covered boolean not null,
  constraint subscription_impact_event_registrations_payee_chk check (
    (registration_id is not null and manual_participant_id is null)
    or (registration_id is null and manual_participant_id is not null)
  )
);

create index if not exists subscription_impact_event_registrations_event_idx
  on public.subscription_impact_event_registrations (event_id);

alter table public.subscription_impact_event_registrations enable row level security;

drop policy if exists subscription_impact_event_registrations_manager_all on public.subscription_impact_event_registrations;
create policy subscription_impact_event_registrations_manager_all on public.subscription_impact_event_registrations
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- ---------------------------------------------------------------------------
-- Core helpers
-- ---------------------------------------------------------------------------

create or replace function public.subscription_tier_for_capacity(p_max_participants int)
returns public.subscription_tier
language sql
immutable
as $$
  select case
    when p_max_participants is null then null
    when p_max_participants <= 1 then 'personal'
    when p_max_participants = 2 then 'pair'
    when p_max_participants = 3 then 'trio'
    when p_max_participants = 4 then 'quartet'
    when p_max_participants = 5 then 'quintet'
    when p_max_participants = 6 then 'sextet'
    else 'group'
  end::public.subscription_tier;
$$;

comment on function public.subscription_tier_for_capacity(int) is
  'Maps a session''s configured max_participants to a subscription_tier. Always derived from '
  'configured capacity, never from how many athletes happen to be registered.';

-- No `grant execute ... to authenticated` here, matching the established convention for
-- internal helpers in this codebase (e.g. _period_merged_athlete_finance, pricing_open_end,
-- pricing_active_on never get a direct grant either) — nested calls from SECURITY DEFINER RPCs
-- run with the definer's privileges regardless of grants, and not exposing this as a directly
-- callable RPC keeps the client-facing surface to exactly the 3 RPCs Phase 2 wires (below).

create or replace function public.subscription_next_anchor_date(p_anchor_day smallint, p_from_date date)
returns date
language plpgsql
immutable
as $$
declare
  v_next_month_start date;
  v_last_day int;
  v_day int;
begin
  if p_anchor_day is null or p_from_date is null then
    return null;
  end if;
  v_next_month_start := (date_trunc('month', p_from_date) + interval '1 month')::date;
  v_last_day := extract(day from ((v_next_month_start + interval '1 month - 1 day')::date))::int;
  v_day := least(greatest(p_anchor_day, 1), v_last_day);
  return make_date(
    extract(year from v_next_month_start)::int,
    extract(month from v_next_month_start)::int,
    v_day
  );
end;
$$;

comment on function public.subscription_next_anchor_date(smallint, date) is
  'Next anchor date strictly in the month after p_from_date''s month, clamped to that month''s '
  'last day (e.g. anchor_day=31: Jan 31 -> Feb 28/29 -> Mar 31 -> Apr 30).';

-- Internal helper, not directly client-callable (see note above subscription_tier_for_capacity).

-- Composite result type for subscription_effective_context().
do $$ begin
  create type public.subscription_effective_context_result as (
    subscription_id uuid,
    version_id uuid,
    in_window boolean,
    is_frozen boolean,
    weekly_limit int
  );
exception when duplicate_object then null;
end $$;

create or replace function public.subscription_effective_context(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_session_date date,
  p_tier public.subscription_tier
)
returns public.subscription_effective_context_result
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_version_id uuid;
  v_frozen boolean := false;
  v_limit int;
  v_result public.subscription_effective_context_result;
begin
  select s.id, v.id
  into v_sub_id, v_version_id
  from public.subscriptions s
  join public.subscription_versions v
    on v.subscription_id = s.id
   and v.effective_from <= p_session_date
   and (v.effective_to is null or v.effective_to > p_session_date)
  where s.payee_id = p_payee_id
    and s.payee_is_manual = p_payee_is_manual
    and s.deleted_at is null
    and v.plan_start_date <= p_session_date
    and (v.plan_end_date is null or v.plan_end_date >= p_session_date)
    and (v.stopped_effective_date is null or v.stopped_effective_date > p_session_date)
  order by v.effective_from desc
  limit 1;

  v_result.subscription_id := v_sub_id;
  v_result.version_id := v_version_id;
  v_result.in_window := v_sub_id is not null;

  if v_sub_id is not null then
    v_frozen := exists (
      select 1
      from public.subscription_freezes f
      where f.subscription_id = v_sub_id
        and f.cancelled_at is null
        and p_session_date between f.freeze_from and f.freeze_until
    );

    select a.weekly_limit into v_limit
    from public.subscription_version_allowances a
    where a.version_id = v_version_id and a.tier = p_tier;
  end if;

  v_result.is_frozen := v_frozen;
  v_result.weekly_limit := v_limit;
  return v_result;
end;
$$;

comment on function public.subscription_effective_context(uuid, boolean, date, public.subscription_tier) is
  'Read helper: for one payee and one calendar date, whether an active subscription/version '
  'covers that date (ignoring freeze), whether it is frozen on that date, and the tier''s '
  'weekly_limit on the effective version.';

-- No direct grant to authenticated: this takes an arbitrary payee_id/payee_is_manual with no
-- caller-identity check, so exposing it as a callable RPC would let any authenticated user query
-- any OTHER payee's subscription existence/allowance (an information-disclosure risk). It is only
-- ever invoked from within other SECURITY DEFINER functions in this codebase, which run with the
-- definer's privileges and need no separate grant. A future phase can add a properly-scoped
-- (self-or-staff-only) read-only preview RPC that wraps this for UI use.

create or replace function public.subscription_version_display_status(
  p_version_id uuid,
  p_as_of_date date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.subscription_versions%rowtype;
begin
  select * into v from public.subscription_versions where id = p_version_id;
  if not found then
    return null;
  end if;

  if v.stopped_effective_date is not null and p_as_of_date >= v.stopped_effective_date then
    return 'stopped';
  end if;

  if v.effective_to is not null and p_as_of_date >= v.effective_to then
    return 'superseded';
  end if;

  if p_as_of_date < v.effective_from then
    return 'scheduled';
  end if;

  if v.plan_end_date is not null and p_as_of_date > v.plan_end_date then
    return 'completed';
  end if;

  if exists (
    select 1 from public.subscription_freezes f
    where f.subscription_id = v.subscription_id
      and f.cancelled_at is null
      and p_as_of_date between f.freeze_from and f.freeze_until
  ) then
    return 'frozen';
  end if;

  return 'active';
end;
$$;

comment on function public.subscription_version_display_status(uuid, date) is
  'Computed lifecycle status for a subscription version: stopped > superseded > scheduled > '
  'completed > frozen > active. Freeze is never persisted as a version status.';

-- No direct grant: same reasoning as subscription_effective_context above — takes an arbitrary
-- version_id with no ownership check, so it stays internal-only until a scoped wrapper exists.

-- Shared advisory-lock key builder so the atomic registration path (Phase 2) and the
-- reconciliation pass guard the exact same critical section for a given payee/week/tier.
create or replace function public.subscription_lock_key(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_week_start date,
  p_tier public.subscription_tier
)
returns bigint
language sql
immutable
as $$
  select hashtextextended(
    coalesce(p_payee_id::text, '') || '|' || coalesce(p_payee_is_manual::text, 'false')
      || '|' || coalesce(p_week_start::text, '') || '|' || coalesce(p_tier::text, ''),
    0
  );
$$;

-- ---------------------------------------------------------------------------
-- Extend _period_merged_athlete_finance: coverage zeroes expected, charges add expected rows.
-- Full current body (from supabase/migrations/20260628000000_athlete_families.sql, the only
-- prior definition of this function) preserved verbatim except for the additions below.
-- ---------------------------------------------------------------------------

create or replace function public._period_merged_athlete_finance(p_start date, p_end date)
returns table (
  kind text,
  pid text,
  expected_ils numeric,
  collected_sessions_ils numeric,
  collected_account_ils numeric,
  collected_total_ils numeric,
  outstanding_ils numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with per_slot as (
    select
      'app'::text as kind,
      reg.user_id::text as pid,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)
      end)::numeric as exp_amt,
      coalesce(reg.amount_paid, 0)::numeric as coll_amt
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is true
    union all
    select
      'app'::text,
      reg.user_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)
      end)::numeric,
      coalesce(reg.amount_paid, 0)::numeric
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is false
      and reg.charge_no_show is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is false
      and m.charge_no_show is true
    union all
    select
      'app'::text,
      c.user_id::text,
      (case when cov.covered then 0
        else coalesce(public.session_billing_price_ils(s.id, c.user_id), 0)
      end)::numeric,
      coalesce(c.penalty_collected_ils, 0)::numeric
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    left join public.session_registrations reg2
      on reg2.session_id = c.session_id and reg2.user_id = c.user_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg2.id
    where s.session_date between p_start and p_end
      and c.charged_full_price is true
    union all
    -- Subscription charges are additional debt-feed line items (recurring/proration/etc.),
    -- attributed to the billing period they were posted for. No separate "collected" side here:
    -- payment against a subscription charge is recorded as an athlete_account_payments row
    -- (already summed in acct_by_ath below), matching the plan's "debt-feed line items only" rule.
    -- Filtered by bp.period_start (not session_date, since a charge has no single session) — a
    -- charge surfaces in whichever p_start/p_end range contains its billing period's start date,
    -- as one lump sum, not smeared across the period's weeks.
    -- Netting (Phase 3, not written yet by this migration): a `reversal` row is expected to carry
    -- a NEGATIVE amount_ils equal to `-1 * ` the charge it reverses (via `reverses`), so that
    -- summing all subscription_charges rows for a payee/period nets to the corrected total with
    -- no double-count — e.g. +300 recurring, -300 reversal, +150 stop_proration nets to +150.
    -- This convention is not enforced by a CHECK constraint here; Phase 3's writer must honor it.
    select
      case when sc.payee_is_manual then 'manual' else 'app' end::text,
      sc.payee_id::text,
      sc.amount_ils::numeric,
      0::numeric
    from public.subscription_charges sc
    join public.subscription_billing_periods bp on bp.id = sc.billing_period_id
    where bp.period_start between p_start and p_end
  ),
  sess_by_ath as (
    select
      ps.kind,
      ps.pid,
      round(sum(ps.exp_amt)::numeric, 2) as expected_ils,
      round(sum(ps.coll_amt)::numeric, 2) as collected_sessions_ils
    from per_slot ps
    group by ps.kind, ps.pid
  ),
  acct_by_ath as (
    select
      case when a.payee_is_manual then 'manual' else 'app' end as kind,
      a.payee_id::text as pid,
      round(sum(a.amount_ils)::numeric, 2) as collected_account_ils
    from public.athlete_account_payments a
    where a.paid_at between p_start and p_end
    group by 1, 2
  ),
  ath_keys as (
    select kind, pid from sess_by_ath
    union
    select kind, pid from acct_by_ath
  )
  select
    k.kind,
    k.pid,
    coalesce(s.expected_ils, 0)::numeric as expected_ils,
    coalesce(s.collected_sessions_ils, 0)::numeric as collected_sessions_ils,
    coalesce(a.collected_account_ils, 0)::numeric as collected_account_ils,
    (coalesce(s.collected_sessions_ils, 0) + coalesce(a.collected_account_ils, 0))::numeric as collected_total_ils,
    round((
      coalesce(s.expected_ils, 0)
      - coalesce(s.collected_sessions_ils, 0)
      - coalesce(a.collected_account_ils, 0)
    )::numeric, 2) as outstanding_ils
  from ath_keys k
  left join sess_by_ath s on s.kind = k.kind and s.pid = k.pid
  left join acct_by_ath a on a.kind = k.kind and a.pid = k.pid;
$$;

-- Family aggregation (public._manager_weekly_stats_families_json, in
-- 20260628000000_athlete_families.sql) requires ZERO code changes: it already just sums
-- public._period_merged_athlete_finance(p_start, p_end) per member (joined by kind/pid), so the
-- coverage/charges additions above flow through automatically. Verified by reading its body:
-- it groups by athlete_families/athlete_family_members and left-joins this function's output —
-- no per-athlete session/coverage logic of its own to update.
