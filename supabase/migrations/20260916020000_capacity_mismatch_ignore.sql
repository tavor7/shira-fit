-- Reversible ignore/unignore for capacity-mismatch rows (mirrors the shape of
-- super_user_hidden_registrations): a row with unignored_at null means "currently
-- ignored". Ignoring re-ignoring later creates a fresh row so history is kept.
create table if not exists public.manager_capacity_mismatch_ignores (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  ignored_at timestamptz not null default now(),
  ignored_by uuid not null references public.profiles (user_id),
  unignored_at timestamptz null,
  unignored_by uuid null references public.profiles (user_id),
  created_at timestamptz not null default now()
);

create unique index if not exists manager_capacity_mismatch_ignores_active_uq
  on public.manager_capacity_mismatch_ignores (session_id)
  where unignored_at is null;

create index if not exists manager_capacity_mismatch_ignores_session_idx
  on public.manager_capacity_mismatch_ignores (session_id);

alter table public.manager_capacity_mismatch_ignores enable row level security;

drop policy if exists "manager_capacity_mismatch_ignores_all" on public.manager_capacity_mismatch_ignores;
create policy "manager_capacity_mismatch_ignores_all" on public.manager_capacity_mismatch_ignores
  for all using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));

create or replace function public._is_capacity_mismatch_ignored(p_session_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.manager_capacity_mismatch_ignores i
    where i.session_id = p_session_id and i.unignored_at is null
  );
$$;

-- Drop the old two-arg signature first: a new three-arg overload with a default
-- third param would otherwise be ambiguous with it for existing two-arg callers.
drop function if exists public.manager_capacity_mismatch(date, text);

-- p_show_ignored: false (default) lists active mismatches, excluding ignored rows,
-- for the main "Capacity mismatch" list and its dashboard badge count. true lists
-- only the currently-ignored rows, for the "See ignored" tab.
create or replace function public.manager_capacity_mismatch(
  p_anchor date,
  p_mode text default 'week'::text,
  p_show_ignored boolean default false
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_start date;
  v_end date;
  v_result json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month', 'global') then
    v_mode := 'week';
  end if;

  select b.period_start, b.period_end into v_start, v_end
  from public._manager_stats_period_bounds(p_anchor, v_mode) b;

  select json_build_object(
    'ok', true,
    'week_start', v_start,
    'week_end', v_end,
    'count', coalesce(count(*)::int, 0),
    'sessions', coalesce(
      json_agg(
        json_build_object(
          'session_id', x.session_id,
          'session_date', x.session_date,
          'start_time', x.start_time::text,
          'duration_minutes', x.duration_minutes,
          'coach_name', x.coach_name,
          'max_participants', x.max_participants,
          'registered_count', x.registered_count
        )
        order by x.session_date asc, x.start_time asc
      ),
      '[]'::json
    )
  )
  into v_result
  from (
    select
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      pr.full_name as coach_name,
      s.max_participants,
      public.active_registration_count(s.id) as registered_count
    from public.training_sessions s
    left join public.profiles pr on pr.user_id = s.coach_id
    where s.session_date between v_start and v_end
      and s.max_participants < 12
      and public._session_has_ended(s)
      and public.active_registration_count(s.id) <> s.max_participants
      and not public._session_is_slot_roster_ghost(s.id)
      and public._is_capacity_mismatch_ignored(s.id) = p_show_ignored
  ) x;

  return v_result;
end;
$function$;

create or replace function public.manager_set_capacity_mismatch_ignored(
  p_session_id uuid,
  p_ignored boolean
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  if p_ignored then
    insert into public.manager_capacity_mismatch_ignores (session_id, ignored_by)
    values (p_session_id, v_uid)
    on conflict (session_id) where unignored_at is null do nothing;
  else
    update public.manager_capacity_mismatch_ignores
    set unignored_at = now(), unignored_by = v_uid
    where session_id = p_session_id and unignored_at is null;
  end if;

  return json_build_object('ok', true);
end;
$function$;

grant execute on function public.manager_capacity_mismatch(date, text, boolean) to authenticated;
grant execute on function public.manager_set_capacity_mismatch_ignored(uuid, boolean) to authenticated;
