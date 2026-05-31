-- Optional family groups for aggregated billing display (read-time sum; payments stay per-member).

create table if not exists public.athlete_families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.athlete_family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.athlete_families(id) on delete cascade,
  user_id uuid references public.profiles(user_id) on delete cascade,
  manual_participant_id uuid references public.manual_participants(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint athlete_family_members_one_payee check (
    (user_id is not null and manual_participant_id is null)
    or (user_id is null and manual_participant_id is not null)
  )
);

create unique index if not exists athlete_family_members_user_id_unique
  on public.athlete_family_members(user_id)
  where user_id is not null;

create unique index if not exists athlete_family_members_manual_id_unique
  on public.athlete_family_members(manual_participant_id)
  where manual_participant_id is not null;

create unique index if not exists athlete_family_members_family_user_unique
  on public.athlete_family_members(family_id, user_id)
  where user_id is not null;

create unique index if not exists athlete_family_members_family_manual_unique
  on public.athlete_family_members(family_id, manual_participant_id)
  where manual_participant_id is not null;

create index if not exists athlete_family_members_family_id_idx
  on public.athlete_family_members(family_id);

alter table public.athlete_families enable row level security;
alter table public.athlete_family_members enable row level security;

create policy "athlete_families_manager_all" on public.athlete_families
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

create policy "athlete_family_members_manager_all" on public.athlete_family_members
  for all
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- Per-athlete finance rows for a date range (shared by family aggregation).
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
      coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric as exp_amt,
      coalesce(reg.amount_paid, 0)::numeric as coll_amt
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    where s.session_date between p_start and p_end
      and m.attended is true
    union all
    select
      'app'::text,
      reg.user_id::text,
      coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric,
      coalesce(reg.amount_paid, 0)::numeric
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is false
      and reg.charge_no_show is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    where s.session_date between p_start and p_end
      and m.attended is false
      and m.charge_no_show is true
    union all
    select
      'app'::text,
      c.user_id::text,
      coalesce(public.session_billing_price_ils(s.id, c.user_id), 0)::numeric,
      coalesce(c.penalty_collected_ils, 0)::numeric
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    where s.session_date between p_start and p_end
      and c.charged_full_price is true
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

create or replace function public.list_athlete_families()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  return json_build_object(
    'ok', true,
    'families', coalesce((
      select json_agg(row_to_json(x) order by x.name)
      from (
        select
          f.id,
          f.name,
          coalesce((
            select json_agg(
              json_build_object(
                'kind', case when fm.user_id is not null then 'app' else 'manual' end,
                'id', coalesce(fm.user_id, fm.manual_participant_id),
                'name', case
                  when fm.user_id is not null then (select pr.full_name from public.profiles pr where pr.user_id = fm.user_id)
                  else (select mp.full_name from public.manual_participants mp where mp.id = fm.manual_participant_id)
                end
              )
              order by 4 nulls last
            )
            from public.athlete_family_members fm
            where fm.family_id = f.id
          ), '[]'::json) as members
        from public.athlete_families f
        order by f.name
      ) x
    ), '[]'::json)
  );
end;
$$;

create or replace function public.get_athlete_family(p_payee_id uuid, p_payee_is_manual boolean default false)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_family_id uuid;
  v_name text;
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_payee_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  select fm.family_id, f.name
  into v_family_id, v_name
  from public.athlete_family_members fm
  join public.athlete_families f on f.id = fm.family_id
  where (
    (not p_payee_is_manual and fm.user_id = p_payee_id)
    or (p_payee_is_manual and fm.manual_participant_id = p_payee_id)
  )
  limit 1;

  if v_family_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  return json_build_object(
    'ok', true,
    'family', json_build_object(
      'id', v_family_id,
      'name', v_name,
      'members', coalesce((
        select json_agg(
          json_build_object(
            'kind', case when fm.user_id is not null then 'app' else 'manual' end,
            'id', coalesce(fm.user_id, fm.manual_participant_id),
            'name', case
              when fm.user_id is not null then (select pr.full_name from public.profiles pr where pr.user_id = fm.user_id)
              else (select mp.full_name from public.manual_participants mp where mp.id = fm.manual_participant_id)
            end,
            'payee_is_manual', fm.manual_participant_id is not null
          )
          order by 4 nulls last
        )
        from public.athlete_family_members fm
        where fm.family_id = v_family_id
      ), '[]'::json)
    )
  );
end;
$$;

create or replace function public.delete_athlete_family(p_family_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_family_id is null then
    return json_build_object('ok', false, 'error', 'missing_family_id');
  end if;

  delete from public.athlete_families where id = p_family_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.upsert_athlete_family(
  p_family_id uuid,
  p_name text,
  p_members jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_family_id uuid;
  v_name text;
  v_member jsonb;
  v_kind text;
  v_id uuid;
  v_other_family uuid;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_name := trim(coalesce(p_name, ''));
  if char_length(v_name) = 0 then
    return json_build_object('ok', false, 'error', 'name_required');
  end if;

  if p_family_id is null then
    insert into public.athlete_families(name) values (v_name) returning id into v_family_id;
  else
    update public.athlete_families
    set name = v_name, updated_at = now()
    where id = p_family_id
    returning id into v_family_id;
    if v_family_id is null then
      return json_build_object('ok', false, 'error', 'not_found');
    end if;
    delete from public.athlete_family_members where family_id = v_family_id;
  end if;

  if jsonb_typeof(p_members) <> 'array' then
    return json_build_object('ok', false, 'error', 'invalid_members');
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    v_kind := lower(trim(coalesce(v_member->>'kind', '')));
    v_id := nullif(trim(v_member->>'id'), '')::uuid;

    if v_id is null or v_kind not in ('app', 'manual') then
      return json_build_object('ok', false, 'error', 'invalid_member');
    end if;

    if v_kind = 'app' then
      if not exists (
        select 1 from public.profiles pr where pr.user_id = v_id and pr.role = 'athlete'
      ) then
        return json_build_object('ok', false, 'error', 'invalid_athlete');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.user_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, user_id)
      values (v_family_id, v_id);
    else
      if not exists (select 1 from public.manual_participants mp where mp.id = v_id) then
        return json_build_object('ok', false, 'error', 'invalid_manual');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.manual_participant_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, manual_participant_id)
      values (v_family_id, v_id);
    end if;
  end loop;

  return json_build_object('ok', true, 'family_id', v_family_id);
end;
$$;

-- Extend participant_registration_history with optional family filter.
drop function if exists public.participant_registration_history(date, date, text, uuid);

create or replace function public.participant_registration_history(
  p_start date,
  p_end date,
  p_phone_search text default null,
  p_athlete_key uuid default null,
  p_family_id uuid default null
)
returns table (
  registration_id uuid,
  athlete_user_id uuid,
  athlete_name text,
  athlete_phone text,
  session_id uuid,
  session_date date,
  start_time time,
  duration_minutes int,
  max_participants int,
  reg_status public.registration_status,
  registered_at timestamptz,
  attended boolean,
  payment_method text,
  amount_paid numeric,
  payment_recorded_by_name text,
  payment_recorded_at timestamptz,
  cancellation_reason text,
  cancellation_within_24h boolean,
  cancellation_within_12h boolean,
  cancelled_at timestamptz,
  charge_no_show boolean,
  cancellation_charged boolean,
  cancellation_penalty_collected numeric,
  cancellation_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  return query
  select
    u.registration_id,
    u.athlete_user_id,
    u.athlete_name,
    u.athlete_phone,
    u.session_id,
    u.session_date,
    u.start_time,
    u.duration_minutes,
    u.max_participants,
    u.reg_status,
    u.registered_at,
    u.attended,
    u.payment_method,
    u.amount_paid,
    u.payment_recorded_by_name,
    u.payment_recorded_at,
    u.cancellation_reason,
    u.cancellation_within_24h,
    u.cancellation_within_12h,
    u.cancelled_at,
    u.charge_no_show,
    u.cancellation_charged,
    u.cancellation_penalty_collected,
    u.cancellation_id
  from (
    select
      r.id as registration_id,
      r.user_id as athlete_user_id,
      p.full_name as athlete_name,
      p.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      s.max_participants as max_participants,
      r.status as reg_status,
      r.registered_at,
      r.attended,
      r.payment_method,
      r.amount_paid,
      pr.full_name as payment_recorded_by_name,
      r.payment_recorded_at,
      c.reason as cancellation_reason,
      case
        when c.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '24 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_24h,
      case
        when c.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '12 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_12h,
      c.cancelled_at,
      case when r.status = 'active' then r.charge_no_show else null end as charge_no_show,
      case when c.cancelled_at is not null then c.charged_full_price else null end as cancellation_charged,
      case when c.cancelled_at is not null then c.penalty_collected_ils else null end as cancellation_penalty_collected,
      c.cancellation_id
    from public.session_registrations r
    join public.profiles p on p.user_id = r.user_id
    join public.training_sessions s on s.id = r.session_id
    left join public.profiles pr on pr.user_id = r.payment_recorded_by
    left join lateral (
      select
        c2.id as cancellation_id,
        c2.reason,
        c2.cancelled_at,
        c2.charged_full_price,
        c2.penalty_collected_ils
      from public.cancellations c2
      where c2.session_id = r.session_id
        and c2.user_id = r.user_id
      order by c2.cancelled_at desc
      limit 1
    ) c on true
    where p.role = 'athlete'
      and s.session_date >= p_start
      and s.session_date <= p_end
      and (
        p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or p.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        case
          when p_family_id is not null then
            r.user_id in (
              select fm.user_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.user_id is not null
            )
          else
            p_athlete_key is null or r.user_id = p_athlete_key
        end
      )
      and (
        r.status <> 'cancelled'
        or (
          c.cancelled_at is not null
          and ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '12 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        )
      )

    union all

    select
      smp.id as registration_id,
      smp.manual_participant_id as athlete_user_id,
      mp.full_name as athlete_name,
      mp.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      s.max_participants as max_participants,
      'active'::public.registration_status as reg_status,
      smp.added_at as registered_at,
      smp.attended,
      smp.payment_method,
      smp.amount_paid,
      pr.full_name as payment_recorded_by_name,
      smp.payment_recorded_at,
      cm.reason as cancellation_reason,
      case
        when cm.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - cm.cancelled_at) <= interval '24 hours'
          and cm.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_24h,
      case
        when cm.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - cm.cancelled_at) <= interval '12 hours'
          and cm.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_12h,
      cm.cancelled_at,
      smp.charge_no_show as charge_no_show,
      case when cm.cancelled_at is not null then cm.charged_full_price else null end as cancellation_charged,
      case when cm.cancelled_at is not null then cm.penalty_collected_ils else null end as cancellation_penalty_collected,
      cm.cancellation_id
    from public.session_manual_participants smp
    join public.manual_participants mp on mp.id = smp.manual_participant_id
    join public.training_sessions s on s.id = smp.session_id
    left join public.profiles pr on pr.user_id = smp.payment_recorded_by
    left join lateral (
      select
        c2.id as cancellation_id,
        c2.reason,
        c2.cancelled_at,
        c2.charged_full_price,
        c2.penalty_collected_ils
      from public.cancellations c2
      where mp.linked_user_id is not null
        and c2.session_id = smp.session_id
        and c2.user_id = mp.linked_user_id
      order by c2.cancelled_at desc
      limit 1
    ) cm on true
    where s.session_date >= p_start
      and s.session_date <= p_end
      and (
        p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or mp.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        case
          when p_family_id is not null then
            smp.manual_participant_id in (
              select fm.manual_participant_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.manual_participant_id is not null
            )
            or mp.linked_user_id in (
              select fm.user_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.user_id is not null
            )
          else
            p_athlete_key is null
            or smp.manual_participant_id = p_athlete_key
            or mp.linked_user_id = p_athlete_key
        end
      )
  ) u
  order by u.athlete_name asc, u.session_date desc, u.start_time desc;
end;
$$;

grant execute on function public.participant_registration_history(date, date, text, uuid, uuid) to authenticated;

-- Append finance.families to manager_weekly_stats without changing athlete_totals.
create or replace function public._manager_weekly_stats_families_json(p_start date, p_end date)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'id', g.family_id,
        'name', g.family_name,
        'expected_ils', round(g.expected_ils::numeric, 2),
        'collected_sessions_ils', round(g.collected_sessions_ils::numeric, 2),
        'collected_account_ils', round(g.collected_account_ils::numeric, 2),
        'collected_total_ils', round(g.collected_total_ils::numeric, 2),
        'outstanding_ils', round(g.outstanding_ils::numeric, 2),
        'members', g.members_json
      )
      order by g.outstanding_ils desc nulls last, g.family_name
    ),
    '[]'::json
  )
  from (
    select
      f.id as family_id,
      f.name as family_name,
      sum(coalesce(m.expected_ils, 0)) as expected_ils,
      sum(coalesce(m.collected_sessions_ils, 0)) as collected_sessions_ils,
      sum(coalesce(m.collected_account_ils, 0)) as collected_account_ils,
      sum(coalesce(m.collected_total_ils, 0)) as collected_total_ils,
      sum(coalesce(m.outstanding_ils, 0)) as outstanding_ils,
      json_agg(
        json_build_object(
          'kind', fm.kind,
          'id', fm.pid,
          'name', fm.disp_name,
          'expected_ils', round(coalesce(m.expected_ils, 0)::numeric, 2),
          'collected_sessions_ils', round(coalesce(m.collected_sessions_ils, 0)::numeric, 2),
          'collected_account_ils', round(coalesce(m.collected_account_ils, 0)::numeric, 2),
          'collected_total_ils', round(coalesce(m.collected_total_ils, 0)::numeric, 2),
          'outstanding_ils', round(coalesce(m.outstanding_ils, 0)::numeric, 2)
        )
        order by coalesce(m.outstanding_ils, 0) desc nulls last, fm.disp_name nulls last
      ) as members_json
    from public.athlete_families f
    join (
      select
        fm.family_id,
        case when fm.user_id is not null then 'app' else 'manual' end as kind,
        coalesce(fm.user_id, fm.manual_participant_id)::text as pid,
        case
          when fm.user_id is not null then (select pr.full_name from public.profiles pr where pr.user_id = fm.user_id)
          else (select mp.full_name from public.manual_participants mp where mp.id = fm.manual_participant_id)
        end as disp_name
      from public.athlete_family_members fm
    ) fm on fm.family_id = f.id
    left join public._period_merged_athlete_finance(p_start, p_end) m
      on m.kind = fm.kind and m.pid = fm.pid
    group by f.id, f.name
    having count(fm.pid) > 0
  ) g;
$$;

-- Extend manager_weekly_stats: rename core implementation, wrap to append finance.families.
alter function public.manager_weekly_stats(date, text) rename to manager_weekly_stats_core;

create or replace function public.manager_weekly_stats(p_anchor date, p_mode text default 'week')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result json;
  v_start date;
  v_end date;
  v_finance json;
begin
  v_result := public.manager_weekly_stats_core(p_anchor, p_mode);

  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;

  v_start := (v_result->>'week_start')::date;
  v_end := (v_result->>'week_end')::date;
  v_finance := v_result->'finance';

  v_finance := (
    coalesce(v_finance, '{}'::json)::jsonb
    || jsonb_build_object(
      'families',
      coalesce(public._manager_weekly_stats_families_json(v_start, v_end), '[]'::json)::jsonb
    )
  )::json;

  return jsonb_set(v_result::jsonb, '{finance}', v_finance::jsonb)::json;
end;
$$;

grant execute on function public.list_athlete_families() to authenticated;
grant execute on function public.get_athlete_family(uuid, boolean) to authenticated;
grant execute on function public.delete_athlete_family(uuid) to authenticated;
grant execute on function public.upsert_athlete_family(uuid, text, jsonb) to authenticated;
