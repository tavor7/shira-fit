-- Per-audience hide scope: a hide can independently target the athlete, coaches,
-- and/or regular managers. The Super User always sees everything regardless of
-- these flags (enforced in every consumer below, not just here).

alter table public.super_user_hidden_registrations
  add column if not exists hide_from_athlete boolean not null default true,
  add column if not exists hide_from_coach boolean not null default false,
  add column if not exists hide_from_manager boolean not null default false;

-- "Hidden from the athlete" — drives the athlete's own RLS visibility AND the
-- unconditional debt/attendance/stats exclusion (unchanged meaning from before).
create or replace function public.is_registration_hidden(p_session_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.super_user_hidden_registrations h
    where h.session_id = p_session_id and h.user_id = p_user_id
      and h.unhidden_at is null and h.hide_from_athlete
  );
$$;

create or replace function public.is_registration_hidden_from_coach(p_session_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.super_user_hidden_registrations h
    where h.session_id = p_session_id and h.user_id = p_user_id
      and h.unhidden_at is null and h.hide_from_coach
  );
$$;

create or replace function public.is_registration_hidden_from_manager(p_session_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.super_user_hidden_registrations h
    where h.session_id = p_session_id and h.user_id = p_user_id
      and h.unhidden_at is null and h.hide_from_manager
  );
$$;

-- Needed to distinguish coach vs manager in RLS/RPCs below (didn't exist before —
-- everything used the combined is_coach_or_manager()).
create or replace function public.is_coach(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.user_id = uid and p.role = 'coach');
$$;

grant execute on function public.is_registration_hidden_from_coach(uuid, uuid) to authenticated;
grant execute on function public.is_registration_hidden_from_manager(uuid, uuid) to authenticated;
grant execute on function public.is_coach(uuid) to authenticated;
