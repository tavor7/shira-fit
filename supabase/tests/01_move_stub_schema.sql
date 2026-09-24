-- Supplementary stand-in schema for testing the bypass-closure fixes:
-- staff_move_session_participant and the session-series roster auto-copy path.

create or replace function public._week_start_sunday(d date)
returns date
language sql
stable
as $$
  select (d - (extract(dow from d)::int))::date;
$$;

create or replace function public._session_has_started(v_sess public.training_sessions)
returns boolean
language plpgsql
stable
as $$
declare
  v_start timestamptz;
begin
  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp);
  return now() >= v_start;
end;
$$;

create or replace function public._staff_can_manage_session(p_uid uuid, p_sess public.training_sessions)
returns boolean
language sql
stable
as $$
  select
    public.is_manager(p_uid)
    or (
      p_sess.coach_id = p_uid
      and exists (select 1 from public.profiles p where p.user_id = p_uid and p.role = 'coach')
    );
$$;

create or replace function public._sessions_same_studio_week(p_date_a date, p_date_b date)
returns boolean
language sql
stable
as $$
  select public._week_start_sunday(p_date_a) = public._week_start_sunday(p_date_b);
$$;

-- Minimal activity-log stand-in (real table is public.user_activity_events).
create table if not exists public.user_activity_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid,
  event_type text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb
);

create or replace function public._activity_log_enabled()
returns boolean
language sql
stable
as $$
  select true;
$$;

-- Minimal session-series stand-ins so staff_create_session_series/_copy_session_roster load;
-- tests exercise _copy_session_roster and _series_add_manual_participant_checked directly
-- rather than the full series-generation machinery.
do $$ begin
  create type public.session_series_repeat_mode as enum ('ongoing', 'fixed_weeks');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.session_series_roster_policy as enum ('none', 'copy_on_create', 'copy_on_generate');
exception when duplicate_object then null;
end $$;

create table if not exists public.session_series (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  anchor_date date not null,
  start_time time not null,
  duration_minutes int not null default 60,
  max_participants int not null,
  is_open_for_registration boolean not null default false,
  is_hidden boolean not null default false,
  is_kickbox boolean not null default false,
  custom_slot_price_ils numeric null,
  repeat_mode public.session_series_repeat_mode not null default 'ongoing',
  fixed_weeks int null,
  roster_policy public.session_series_roster_policy not null default 'none',
  status text not null default 'active',
  ended_from_date date null,
  created_by uuid null
);

alter table public.training_sessions add column if not exists series_id uuid;
alter table public.training_sessions add column if not exists series_detached boolean not null default false;

create or replace function public._studio_today_date()
returns date
language sql
stable
as $$
  select current_date;
$$;

create or replace function public._series_horizon_end()
returns date
language sql
stable
as $$
  select public._studio_today_date() + 35;
$$;

create or replace function public._generate_series_occurrences(
  p_series_id uuid, p_from date, p_to date
) returns int
language plpgsql
as $$
begin
  return 0;
end;
$$;

create or replace function public._insert_activity_event(
  p_actor uuid,
  p_event_type text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb
) returns void
language plpgsql
as $$
begin
  if not public._activity_log_enabled() then
    return;
  end if;
  insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (p_actor, p_event_type, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;
