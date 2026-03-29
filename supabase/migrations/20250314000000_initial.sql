-- Shira Fit — initial schema, RLS, RPCs
-- Run in Supabase SQL editor or via CLI

-- Extensions
create extension if not exists "pgcrypto";

-- Enums
do $$ begin
  create type public.user_role as enum ('athlete', 'coach', 'manager');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.approval_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.registration_status as enum ('active', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.history_event as enum ('registered', 'cancelled', 'removed');
exception when duplicate_object then null;
end $$;

-- Profiles (1:1 auth.users)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  full_name text not null,
  phone text not null,
  age int not null check (age >= 0 and age <= 120),
  gender text not null,
  approval_status approval_status not null default 'pending',
  role user_role not null default 'athlete',
  expo_push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_approval_idx on public.profiles (approval_status);

-- Training sessions
create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  start_time time not null,
  coach_id uuid not null references public.profiles (user_id) on delete restrict,
  max_participants int not null check (max_participants > 0),
  is_open_for_registration boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_sessions_date_idx on public.training_sessions (session_date);

-- Session registrations
create table if not exists public.session_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  registered_at timestamptz not null default now(),
  status registration_status not null default 'active',
  unique (session_id, user_id)
);

create index if not exists session_registrations_session_idx on public.session_registrations (session_id);
create index if not exists session_registrations_user_idx on public.session_registrations (user_id);

-- Waitlist
create table if not exists public.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  requested_at timestamptz not null default now(),
  unique (session_id, user_id)
);

-- Cancellations (audit)
create table if not exists public.cancellations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  cancelled_at timestamptz not null default now(),
  reason text not null,
  charged_full_price boolean not null default false
);

-- Registration history
create table if not exists public.registration_history (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  event_type history_event not null,
  event_at timestamptz not null default now(),
  meta jsonb default '{}'
);

-- Updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists profiles_updated on public.profiles;
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists training_sessions_updated on public.training_sessions;
create trigger training_sessions_updated before update on public.training_sessions
  for each row execute function public.set_updated_at();

-- Helpers
create or replace function public.is_manager(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.user_id = uid and p.role = 'manager');
$$;

create or replace function public.is_coach_or_manager(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.user_id = uid and p.role in ('coach', 'manager'));
$$;

create or replace function public.active_registration_count(sid uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from session_registrations r
  where r.session_id = sid and r.status = 'active';
$$;

-- Auto profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, username, full_name, phone, age, gender, approval_status, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'phone', ''),
    greatest(0, least(120, coalesce((new.raw_user_meta_data->>'age')::int, 18))),
    coalesce(new.raw_user_meta_data->>'gender', ''),
    'pending',
    'athlete'
  );
  return new;
exception when unique_violation then
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.training_sessions enable row level security;
alter table public.session_registrations enable row level security;
alter table public.waitlist_requests enable row level security;
alter table public.cancellations enable row level security;
alter table public.registration_history enable row level security;

-- Profiles policies
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = user_id or public.is_coach_or_manager(auth.uid()));

drop policy if exists "profiles_update_own_athlete" on public.profiles;
create policy "profiles_update_own_athlete" on public.profiles for update
  using (auth.uid() = user_id and role = 'athlete')
  with check (auth.uid() = user_id);

drop policy if exists "profiles_manager_all" on public.profiles;
create policy "profiles_manager_all" on public.profiles for all
  using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

-- Coaches can read all profiles (participants)
drop policy if exists "profiles_coach_read" on public.profiles;
create policy "profiles_coach_read" on public.profiles for select
  using (public.is_coach_or_manager(auth.uid()));

-- Training sessions: athletes see open + approved week logic enforced in app; DB: read if open or registered
drop policy if exists "sessions_select" on public.training_sessions;
create policy "sessions_select" on public.training_sessions for select using (
  public.is_coach_or_manager(auth.uid())
  or is_open_for_registration = true
  or exists (
    select 1 from session_registrations r
    where r.session_id = training_sessions.id and r.user_id = auth.uid() and r.status = 'active'
  )
);

drop policy if exists "sessions_manager_write" on public.training_sessions;
create policy "sessions_manager_write" on public.training_sessions for insert
  with check (public.is_manager(auth.uid()));

drop policy if exists "sessions_manager_update" on public.training_sessions;
create policy "sessions_manager_update" on public.training_sessions for update
  using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

drop policy if exists "sessions_manager_delete" on public.training_sessions;
create policy "sessions_manager_delete" on public.training_sessions for delete
  using (public.is_manager(auth.uid()));

-- Registrations
drop policy if exists "reg_select" on public.session_registrations;
create policy "reg_select" on public.session_registrations for select using (
  user_id = auth.uid() or public.is_coach_or_manager(auth.uid())
);

drop policy if exists "reg_insert_self" on public.session_registrations;
create policy "reg_insert_self" on public.session_registrations for insert
  with check (user_id = auth.uid());

drop policy if exists "reg_update_manager" on public.session_registrations;
create policy "reg_update_manager" on public.session_registrations for update
  using (public.is_manager(auth.uid()));

drop policy if exists "reg_delete_manager" on public.session_registrations;
create policy "reg_delete_manager" on public.session_registrations for delete
  using (public.is_manager(auth.uid()));

-- Waitlist
drop policy if exists "waitlist_select" on public.waitlist_requests;
create policy "waitlist_select" on public.waitlist_requests for select using (
  user_id = auth.uid() or public.is_coach_or_manager(auth.uid())
);

drop policy if exists "waitlist_insert_self" on public.waitlist_requests;
create policy "waitlist_insert_self" on public.waitlist_requests for insert
  with check (user_id = auth.uid());

drop policy if exists "waitlist_delete_self" on public.waitlist_requests;
create policy "waitlist_delete_self" on public.waitlist_requests for delete
  using (user_id = auth.uid() or public.is_manager(auth.uid()));

-- Cancellations + history: coach/manager read; insert via RPC mostly
drop policy if exists "cancellations_select" on public.cancellations;
create policy "cancellations_select" on public.cancellations for select using (
  user_id = auth.uid() or public.is_coach_or_manager(auth.uid())
);

drop policy if exists "history_select" on public.registration_history;
create policy "history_select" on public.registration_history for select using (
  user_id = auth.uid() or public.is_coach_or_manager(auth.uid())
);

-- RPC: register_for_session
create or replace function public.register_for_session(p_session_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not v_sess.is_open_for_registration then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  if exists (select 1 from session_registrations where session_id = p_session_id and user_id = v_uid and status = 'active') then
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;
  insert into session_registrations (session_id, user_id, status) values (p_session_id, v_uid, 'active');
  insert into registration_history (session_id, user_id, event_type) values (p_session_id, v_uid, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = v_uid;
  return json_build_object('ok', true);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'already_registered');
end;
$$;
grant execute on function public.register_for_session(uuid) to authenticated;

-- RPC: cancel_registration
create or replace function public.cancel_registration(p_session_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess training_sessions%rowtype;
  v_start timestamptz;
  v_charged boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_reason is null or length(trim(p_reason)) < 1 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not exists (
    select 1 from session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;
  v_start := (v_sess.session_date + v_sess.start_time)::timestamptz;
  v_charged := (now() > v_start - interval '12 hours');
  update session_registrations set status = 'cancelled' where session_id = p_session_id and user_id = v_uid and status = 'active';
  if not found then return json_build_object('ok', false, 'error', 'update_failed'); end if;
  insert into cancellations (session_id, user_id, reason, charged_full_price)
  values (p_session_id, v_uid, p_reason, v_charged);
  insert into registration_history (session_id, user_id, event_type, meta)
  values (p_session_id, v_uid, 'cancelled', json_build_object('charged_full_price', v_charged));
  return json_build_object('ok', true, 'charged_full_price', v_charged);
end;
$$;
grant execute on function public.cancel_registration(uuid, text) to authenticated;

-- RPC: coach_add_athlete
create or replace function public.coach_add_athlete(p_session_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not exists (select 1 from profiles where user_id = p_user_id and approval_status = 'approved' and role = 'athlete') then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  insert into session_registrations (session_id, user_id, status) values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update set status = 'active', registered_at = now();
  insert into registration_history (session_id, user_id, event_type) values (p_session_id, p_user_id, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = p_user_id;
  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;
grant execute on function public.coach_add_athlete(uuid, uuid) to authenticated;

-- RPC: manager_remove_athlete
create or replace function public.manager_remove_athlete(p_session_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_deleted int;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  update session_registrations set status = 'cancelled'
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then return json_build_object('ok', false, 'error', 'not_active'); end if;
  insert into registration_history (session_id, user_id, event_type) values (p_session_id, p_user_id, 'removed');
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.manager_remove_athlete(uuid, uuid) to authenticated;

-- RPC: waitlist_request
create or replace function public.request_waitlist(p_session_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
declare v_profile profiles%rowtype;
declare v_count int;
declare v_sess training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if v_profile.approval_status <> 'approved' or v_profile.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  v_count := public.active_registration_count(p_session_id);
  if v_count < v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'not_full');
  end if;
  insert into waitlist_requests (session_id, user_id) values (p_session_id, v_uid)
  on conflict (session_id, user_id) do nothing;
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.request_waitlist(uuid) to authenticated;

-- RPC: approve_athlete (manager)
create or replace function public.set_athlete_approval(p_user_id uuid, p_status approval_status)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  update profiles set approval_status = p_status where user_id = p_user_id and role = 'athlete';
  if not found then return json_build_object('ok', false, 'error', 'not_athlete'); end if;
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.set_athlete_approval(uuid, approval_status) to authenticated;
