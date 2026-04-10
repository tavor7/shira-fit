-- Activity / audit log for manager support: DB events + optional client auth events via RPC.

create table if not exists public.user_activity_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists user_activity_events_created_at_idx
  on public.user_activity_events (created_at desc);

alter table public.user_activity_events enable row level security;

drop policy if exists "user_activity_events_manager_select" on public.user_activity_events;
create policy "user_activity_events_manager_select"
  on public.user_activity_events
  for select
  to authenticated
  using (public.is_manager(auth.uid()));

-- Client-callable (auth events: login, email confirmed, password updated). No direct INSERT on table.
create or replace function public.log_user_activity(
  p_event_type text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (
    auth.uid(),
    p_event_type,
    nullif(trim(coalesce(p_target_type, '')), ''),
    nullif(trim(coalesce(p_target_id, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

grant execute on function public.log_user_activity(text, text, text, jsonb) to authenticated;

create or replace function public._insert_activity_event(
  p_actor uuid,
  p_event_type text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (
    p_actor,
    p_event_type,
    nullif(trim(coalesce(p_target_type, '')), ''),
    nullif(trim(coalesce(p_target_id, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- Log athlete approval / rejection (managers only path).
create or replace function public.set_athlete_approval(p_user_id uuid, p_status public.approval_status)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  update public.profiles
  set approval_status = p_status
  where user_id = p_user_id and role = 'athlete';
  if not found then
    return json_build_object('ok', false, 'error', 'not_athlete');
  end if;
  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (
    auth.uid(),
    case      when p_status = 'approved'::public.approval_status then 'athlete_approved'
      when p_status = 'rejected'::public.approval_status then 'athlete_rejected'
      else 'athlete_approval_updated'
    end,
    'profile',
    p_user_id::text,
    jsonb_build_object('status', p_status::text)
  );
  return json_build_object('ok', true);
end;
$$;

-- profiles: new row
create or replace function public.tg_profiles_activity_ai()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._insert_activity_event(
    auth.uid(),
    case when new.role = 'athlete' then 'athlete_profile_created' else 'profile_created' end,
    'profile',
    new.user_id::text,
    jsonb_build_object('role', new.role::text, 'approval_status', new.approval_status::text)
  );
  return new;
end;
$$;

drop trigger if exists trg_profiles_activity_ai on public.profiles;
create trigger trg_profiles_activity_ai
  after insert on public.profiles
  for each row execute procedure public.tg_profiles_activity_ai();

-- profiles: field edits (not approval-only updates; approval logged in set_athlete_approval)
create or replace function public.tg_profiles_activity_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (old.full_name is distinct from new.full_name)
     or (old.phone is distinct from new.phone)
     or (old.gender is distinct from new.gender)
     or (old.date_of_birth is distinct from new.date_of_birth)
     or (old.username is distinct from new.username)
  then
    perform public._insert_activity_event(
      auth.uid(),
      'profile_updated',
      'profile',
      new.user_id::text,
      jsonb_build_object(
        'full_name', old.full_name is distinct from new.full_name,
        'phone', old.phone is distinct from new.phone,
        'gender', old.gender is distinct from new.gender,
        'date_of_birth', old.date_of_birth is distinct from new.date_of_birth,
        'username', old.username is distinct from new.username
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_activity_au on public.profiles;
create trigger trg_profiles_activity_au
  after update on public.profiles
  for each row
  execute procedure public.tg_profiles_activity_au();

-- training_sessions
create or replace function public.tg_training_sessions_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      uid,
      'session_created',
      'training_session',
      new.id::text,
      jsonb_build_object('session_date', new.session_date, 'coach_id', new.coach_id)
    );
  elsif tg_op = 'UPDATE' then
    perform public._insert_activity_event(
      uid,
      'session_updated',
      'training_session',
      new.id::text,
      jsonb_build_object('session_date', new.session_date, 'coach_id', new.coach_id)
    );
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      uid,
      'session_deleted',
      'training_session',
      old.id::text,
      jsonb_build_object('session_date', old.session_date, 'coach_id', old.coach_id)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_training_sessions_activity_ai on public.training_sessions;
drop trigger if exists trg_training_sessions_activity_au on public.training_sessions;
drop trigger if exists trg_training_sessions_activity_ad on public.training_sessions;

create trigger trg_training_sessions_activity_ai
  after insert on public.training_sessions
  for each row
  execute procedure public.tg_training_sessions_activity();

create trigger trg_training_sessions_activity_au
  after update on public.training_sessions
  for each row
  execute procedure public.tg_training_sessions_activity();

create trigger trg_training_sessions_activity_ad
  after delete on public.training_sessions
  for each row
  execute procedure public.tg_training_sessions_activity();

-- session_registrations
create or replace function public.tg_session_registrations_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      uid,
      'session_registration',
      'session_registration',
      new.id::text,
      jsonb_build_object('session_id', new.session_id, 'user_id', new.user_id, 'status', new.status::text)
    );
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status and new.status = 'cancelled'::public.registration_status then
      perform public._insert_activity_event(
        uid,
        'session_registration_cancelled',
        'session_registration',
        new.id::text,
        jsonb_build_object('session_id', new.session_id, 'user_id', new.user_id)
      );
    elsif old.status is distinct from new.status then
      perform public._insert_activity_event(
        uid,
        'session_registration_status_changed',
        'session_registration',
        new.id::text,
        jsonb_build_object('session_id', new.session_id, 'user_id', new.user_id, 'from', old.status::text, 'to', new.status::text)
      );
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_session_registrations_activity_ai on public.session_registrations;
drop trigger if exists trg_session_registrations_activity_au on public.session_registrations;

create trigger trg_session_registrations_activity_ai
  after insert on public.session_registrations
  for each row
  execute procedure public.tg_session_registrations_activity();

create trigger trg_session_registrations_activity_au
  after update on public.session_registrations
  for each row
  execute procedure public.tg_session_registrations_activity();
