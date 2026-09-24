-- Minimal stand-in schema mirroring the pieces of Shira Fit's real schema that the new
-- subscription migrations depend on. NOT a substitute for the real migration history —
-- used only to syntax/logic-test the two new subscription migration files in isolation,
-- since a full `supabase db reset` on this repo currently fails on an unrelated, pre-existing
-- historical migration conflict (participant_registration_history return-type change at
-- 20250330200000_registration_attendance.sql) that predates this work.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create schema if not exists public;

create type public.user_role as enum ('athlete', 'coach', 'manager');
create type public.approval_status as enum ('pending', 'approved', 'rejected');
create type public.registration_status as enum ('active', 'cancelled');
create type public.history_event as enum ('registered', 'cancelled', 'removed');

create table public.profiles (
  user_id uuid primary key default gen_random_uuid(),
  username text not null unique,
  full_name text not null,
  phone text not null,
  role user_role not null default 'athlete',
  approval_status approval_status not null default 'pending',
  disabled_at timestamptz null
);

create table public.manual_participants (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  linked_user_id uuid null references public.profiles(user_id),
  disabled_at timestamptz null
);

create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  start_time time not null,
  coach_id uuid not null references public.profiles(user_id),
  max_participants int not null,
  is_open_for_registration boolean not null default true,
  is_hidden boolean not null default false,
  is_kickbox boolean not null default false,
  custom_slot_price_ils numeric null,
  duration_minutes int null
);

create table public.session_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  registered_at timestamptz not null default now(),
  status registration_status not null default 'active',
  attended boolean null,
  charge_no_show boolean not null default false,
  payment_method text null,
  amount_paid numeric null,
  payment_recorded_by uuid null,
  payment_recorded_at timestamptz null,
  unique (session_id, user_id)
);

create table public.session_manual_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  manual_participant_id uuid not null references public.manual_participants(id) on delete cascade,
  added_at timestamptz not null default now(),
  attended boolean null,
  charge_no_show boolean not null default false,
  amount_paid numeric null,
  payment_method text null,
  payment_recorded_by uuid null,
  payment_recorded_at timestamptz null,
  unique (session_id, manual_participant_id)
);

create table public.cancellations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  cancelled_at timestamptz not null default now(),
  reason text not null default '',
  charged_full_price boolean not null default false,
  penalty_collected_ils numeric null
);

create table public.registration_history (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_type history_event not null,
  event_at timestamptz not null default now()
);

create table public.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  unique (session_id, user_id)
);

create table public.athlete_account_payments (
  id uuid primary key default gen_random_uuid(),
  payee_id uuid not null,
  payee_is_manual boolean not null default false,
  amount_ils numeric not null,
  payment_method text not null default 'cash',
  paid_at date not null default current_date,
  created_by uuid null
);

-- Stub helpers used by the RPCs under test.
create or replace function public.is_manager(p_uid uuid) returns boolean language sql as $$
  select exists(select 1 from public.profiles where user_id = p_uid and role = 'manager');
$$;

create or replace function public.is_coach(p_uid uuid) returns boolean language sql as $$
  select exists(select 1 from public.profiles where user_id = p_uid and role = 'coach');
$$;

create or replace function public.is_coach_or_manager(p_uid uuid) returns boolean language sql as $$
  select exists(select 1 from public.profiles where user_id = p_uid and role in ('coach','manager'));
$$;

create or replace function public.is_super_user(p_uid uuid) returns boolean language sql as $$
  select false;
$$;

create or replace function public.active_registration_count(p_session_id uuid) returns int language sql as $$
  select (
    (select count(*)::int from public.session_registrations where session_id = p_session_id and status='active')
    + (select count(*)::int from public.session_manual_participants where session_id = p_session_id)
  );
$$;

create or replace function public.athlete_disabled_on_date(p_user_id uuid, p_on date) returns boolean language sql as $$
  select exists(select 1 from public.profiles where user_id = p_user_id and disabled_at is not null and p_on >= disabled_at::date);
$$;

create or replace function public.manual_participant_disabled_on_date(p_manual_id uuid, p_on date) returns boolean language sql as $$
  select exists(select 1 from public.manual_participants where id = p_manual_id and disabled_at is not null and p_on >= disabled_at::date);
$$;

create or replace function public._session_has_ended(v_sess public.training_sessions) returns boolean language sql as $$
  select (v_sess.session_date + v_sess.start_time)::timestamptz < now();
$$;

-- Stub pricing: flat 120 ILS per session regardless of tier, so finance-function math is checkable.
create or replace function public.session_billing_price_ils(p_session_id uuid, p_user_id uuid, p_manual_participant_id uuid default null)
returns numeric language sql as $$
  select 120::numeric;
$$;

-- Simulate auth.uid() used throughout the real RPCs.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('app.current_uid', true), '')::uuid;
$$;
