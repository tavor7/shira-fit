-- Super User account flag + reversible per-athlete-per-workout hiding.
--
-- The Super User is NOT a new role and is never assignable via any UI/RPC:
-- it's an additive boolean on top of the existing 'manager' role, set exactly
-- once by a follow-up migration that links a specific auth.users email.

alter table public.profiles
  add column if not exists is_super_user boolean not null default false;

create index if not exists profiles_is_super_user_idx on public.profiles (is_super_user) where is_super_user;

create or replace function public.is_super_user(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.user_id = uid and p.is_super_user = true);
$$;

-- Reversible hide/unhide audit trail for a specific (session, athlete) pair.
-- A row with unhidden_at is null means "currently hidden"; unhiding sets
-- unhidden_at/unhidden_by rather than deleting, so the centralized screen can
-- show full history and re-hiding later creates a fresh row.
create table if not exists public.super_user_hidden_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  hidden_at timestamptz not null default now(),
  hidden_by uuid not null references public.profiles (user_id),
  unhidden_at timestamptz null,
  unhidden_by uuid null references public.profiles (user_id),
  created_at timestamptz not null default now()
);

create unique index if not exists super_user_hidden_registrations_active_uq
  on public.super_user_hidden_registrations (session_id, user_id)
  where unhidden_at is null;

create index if not exists super_user_hidden_registrations_session_idx
  on public.super_user_hidden_registrations (session_id);
create index if not exists super_user_hidden_registrations_user_idx
  on public.super_user_hidden_registrations (user_id);
create index if not exists super_user_hidden_registrations_hidden_at_idx
  on public.super_user_hidden_registrations (hidden_at);

alter table public.super_user_hidden_registrations enable row level security;

drop policy if exists "super_user_hidden_registrations_all" on public.super_user_hidden_registrations;
create policy "super_user_hidden_registrations_all" on public.super_user_hidden_registrations
  for all using (public.is_super_user(auth.uid())) with check (public.is_super_user(auth.uid()));

-- Reusable predicate: is this (session, athlete) pair currently hidden?
-- Security definer so it can be called from RLS policies on other tables
-- and from RPCs without granting broad table access.
create or replace function public.is_registration_hidden(p_session_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.super_user_hidden_registrations h
    where h.session_id = p_session_id and h.user_id = p_user_id and h.unhidden_at is null
  );
$$;

grant execute on function public.is_super_user(uuid) to authenticated;
grant execute on function public.is_registration_hidden(uuid, uuid) to authenticated;
