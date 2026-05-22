-- Weekly session series: rolling horizon generation + staff create RPC.

create type public.session_series_repeat_mode as enum ('fixed_weeks', 'ongoing');
create type public.session_series_status as enum ('active', 'paused', 'ended');
create type public.session_series_roster_policy as enum ('none', 'copy_on_create', 'copy_on_generate');

create table if not exists public.session_series (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (user_id) on delete restrict,
  anchor_date date not null,
  start_time time not null,
  duration_minutes int not null default 60 check (duration_minutes > 0 and duration_minutes <= 24 * 60),
  max_participants int not null check (max_participants > 0),
  is_open_for_registration boolean not null default false,
  is_hidden boolean not null default false,
  is_kickbox boolean not null default false,
  custom_slot_price_ils numeric(12, 2) null check (custom_slot_price_ils is null or custom_slot_price_ils >= 0),
  repeat_mode public.session_series_repeat_mode not null,
  fixed_weeks int null check (fixed_weeks is null or (fixed_weeks >= 1 and fixed_weeks <= 52)),
  roster_policy public.session_series_roster_policy not null default 'none',
  status public.session_series_status not null default 'active',
  ended_from_date date null,
  created_by uuid null references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_series_fixed_weeks_chk check (
    (repeat_mode = 'fixed_weeks'::public.session_series_repeat_mode and fixed_weeks is not null)
    or (repeat_mode = 'ongoing'::public.session_series_repeat_mode and fixed_weeks is null)
  )
);

create index if not exists session_series_coach_idx on public.session_series (coach_id);
create index if not exists session_series_status_idx on public.session_series (status) where status = 'active';

drop trigger if exists session_series_updated on public.session_series;
create trigger session_series_updated
  before update on public.session_series
  for each row execute function public.set_updated_at();

alter table public.session_series enable row level security;

drop policy if exists session_series_staff_select on public.session_series;
create policy session_series_staff_select on public.session_series
  for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_series_manager_write on public.session_series;
drop policy if exists session_series_staff_write on public.session_series;
create policy session_series_staff_write on public.session_series
  for all
  using (public.is_coach_or_manager(auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()));

alter table public.training_sessions
  add column if not exists series_id uuid null references public.session_series (id) on delete set null,
  add column if not exists series_detached boolean not null default false;

create unique index if not exists training_sessions_series_date_uidx
  on public.training_sessions (series_id, session_date)
  where series_id is not null;

create index if not exists training_sessions_series_id_idx
  on public.training_sessions (series_id)
  where series_id is not null;

comment on table public.session_series is
  'Template for weekly recurring training sessions; occurrences are materialized in training_sessions.';

-- Studio calendar "today" (Asia/Jerusalem).
create or replace function public._studio_today_date()
returns date
language sql
stable
as $$
  select (timezone('Asia/Jerusalem', now()))::date;
$$;

create or replace function public._series_horizon_end()
returns date
language sql
stable
as $$
  select public._studio_today_date() + 35;
$$;

create or replace function public._copy_session_roster(p_from_session uuid, p_to_session uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  m record;
begin
  if p_from_session is null or p_to_session is null or p_from_session = p_to_session then
    return;
  end if;

  for r in
    select user_id
    from public.session_registrations
    where session_id = p_from_session and status = 'active'
  loop
    begin
      perform public.coach_add_athlete(p_to_session, r.user_id, true);
    exception when others then
      null;
    end;
  end loop;

  for m in
    select manual_participant_id
    from public.session_manual_participants
    where session_id = p_from_session
  loop
    begin
      insert into public.session_manual_participants (session_id, manual_participant_id)
      values (p_to_session, m.manual_participant_id)
      on conflict (session_id, manual_participant_id) do nothing;
    exception when others then
      null;
    end;
  end loop;
end;
$$;

-- Materialize weekly occurrence dates in [p_from, p_to] for a series. Returns count inserted.
create or replace function public._generate_series_occurrences(
  p_series_id uuid,
  p_from date,
  p_to date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.session_series%rowtype;
  v_d date;
  v_n int := 0;
  v_inserted int := 0;
  v_max_n int := 520;
  v_prev_session uuid;
  v_new_id uuid;
  v_end date;
begin
  select * into s from public.session_series where id = p_series_id;
  if not found or s.status <> 'active' then
    return 0;
  end if;

  v_end := p_to;
  if s.repeat_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_end := least(p_to, s.anchor_date + ((s.fixed_weeks - 1) * 7));
  elsif s.ended_from_date is not null then
    v_end := least(p_to, s.ended_from_date - 1);
  end if;

  while v_n < v_max_n loop
    v_d := s.anchor_date + (v_n * 7);
    exit when v_d > v_end;
    if v_d >= p_from then
      if not exists (
        select 1 from public.training_sessions t
        where t.series_id = p_series_id and t.session_date = v_d
      ) then
        insert into public.training_sessions (
          session_date,
          start_time,
          coach_id,
          max_participants,
          is_open_for_registration,
          is_hidden,
          is_kickbox,
          custom_slot_price_ils,
          duration_minutes,
          series_id,
          series_detached
        )
        values (
          v_d,
          s.start_time,
          s.coach_id,
          s.max_participants,
          s.is_open_for_registration,
          s.is_hidden,
          s.is_kickbox,
          s.custom_slot_price_ils,
          s.duration_minutes,
          p_series_id,
          false
        )
        returning id into v_new_id;

        v_inserted := v_inserted + 1;

        if s.roster_policy = 'copy_on_generate'::public.session_series_roster_policy then
          select t.id into v_prev_session
          from public.training_sessions t
          where t.series_id = p_series_id
            and t.session_date < v_d
            and t.series_detached = false
          order by t.session_date desc
          limit 1;
          if v_prev_session is not null then
            perform public._copy_session_roster(v_prev_session, v_new_id);
          end if;
        end if;
      end if;
    end if;
    v_n := v_n + 1;
  end loop;

  return v_inserted;
end;
$$;

create or replace function public.staff_create_session_series(
  p_anchor_date date,
  p_start_time time,
  p_coach_id uuid,
  p_max_participants int,
  p_duration_minutes int default 60,
  p_is_open boolean default false,
  p_is_hidden boolean default false,
  p_is_kickbox boolean default false,
  p_custom_slot_price_ils numeric default null,
  p_repeat_mode text default 'ongoing',
  p_fixed_weeks int default null,
  p_copy_roster boolean default false,
  p_athlete_ids uuid[] default '{}',
  p_manual_ids uuid[] default '{}'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode public.session_series_repeat_mode;
  v_weeks int;
  v_series_id uuid;
  v_from date;
  v_to date;
  v_roster public.session_series_roster_policy;
  v_first_session uuid;
  v_sid uuid;
  v_ids uuid[] := '{}';
  v_a uuid;
  v_m uuid;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_anchor_date is null or p_coach_id is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_max_participants is null or p_max_participants < 1 then
    return json_build_object('ok', false, 'error', 'invalid_capacity');
  end if;

  v_mode := case lower(trim(coalesce(p_repeat_mode, 'ongoing')))
    when 'fixed_weeks' then 'fixed_weeks'::public.session_series_repeat_mode
    when 'fixed' then 'fixed_weeks'::public.session_series_repeat_mode
    else 'ongoing'::public.session_series_repeat_mode
  end;

  if v_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_weeks := coalesce(p_fixed_weeks, 4);
    if v_weeks < 1 then v_weeks := 1; end if;
    if v_weeks > 52 then v_weeks := 52; end if;
  else
    v_weeks := null;
  end if;

  v_roster := case
    when not coalesce(p_copy_roster, false) then 'none'::public.session_series_roster_policy
    when v_mode = 'ongoing'::public.session_series_repeat_mode then 'copy_on_generate'::public.session_series_roster_policy
    else 'copy_on_create'::public.session_series_roster_policy
  end;

  insert into public.session_series (
    coach_id,
    anchor_date,
    start_time,
    duration_minutes,
    max_participants,
    is_open_for_registration,
    is_hidden,
    is_kickbox,
    custom_slot_price_ils,
    repeat_mode,
    fixed_weeks,
    roster_policy,
    status,
    created_by
  )
  values (
    p_coach_id,
    p_anchor_date,
    p_start_time,
    greatest(1, coalesce(p_duration_minutes, 60)),
    p_max_participants,
    coalesce(p_is_open, false),
    coalesce(p_is_hidden, false),
    coalesce(p_is_kickbox, false),
    p_custom_slot_price_ils,
    v_mode,
    v_weeks,
    v_roster,
    'active',
    v_uid
  )
  returning id into v_series_id;

  v_from := p_anchor_date;
  if v_mode = 'ongoing'::public.session_series_repeat_mode then
    v_from := greatest(p_anchor_date, public._studio_today_date());
    v_to := public._series_horizon_end();
  else
    v_to := p_anchor_date + ((v_weeks - 1) * 7);
  end if;

  perform public._generate_series_occurrences(v_series_id, v_from, v_to);

  select array_agg(t.id order by t.session_date)
  into v_ids
  from public.training_sessions t
  where t.series_id = v_series_id;

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    v_first_session := v_ids[1];

    if v_roster = 'copy_on_create'::public.session_series_roster_policy then
      foreach v_sid in array v_ids loop
        if v_sid is distinct from v_first_session then
          perform public._copy_session_roster(v_first_session, v_sid);
        end if;
      end loop;
    end if;

    if p_athlete_ids is not null then
      foreach v_a in array p_athlete_ids loop
        if v_a is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public.coach_add_athlete(v_sid, v_a, true);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;

    if p_manual_ids is not null then
      foreach v_m in array p_manual_ids loop
        if v_m is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            insert into public.session_manual_participants (session_id, manual_participant_id)
            values (v_sid, v_m)
            on conflict (session_id, manual_participant_id) do nothing;
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'series_id', v_series_id,
    'session_ids', coalesce(v_ids, '{}'::uuid[]),
    'count', coalesce(array_length(v_ids, 1), 0)
  );
end;
$$;

grant execute on function public.staff_create_session_series(
  date, time, uuid, int, int, boolean, boolean, boolean, numeric, text, int, boolean, uuid[], uuid[]
) to authenticated;

-- Top up ongoing active series through the rolling horizon (call weekly from app or cron).
create or replace function public.maintain_session_series_horizon()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_total int := 0;
  v_n int;
  v_from date;
  v_to date;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_from := public._studio_today_date();
  v_to := public._series_horizon_end();

  for s in
    select id from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    v_n := public._generate_series_occurrences(s.id, v_from, v_to);
    v_total := v_total + coalesce(v_n, 0);
  end loop;

  return json_build_object('ok', true, 'created', v_total);
end;
$$;

grant execute on function public.maintain_session_series_horizon() to authenticated;
