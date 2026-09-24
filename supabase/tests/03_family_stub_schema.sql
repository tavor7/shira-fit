-- Minimal stand-in for athlete_families/athlete_family_members + the real
-- _manager_weekly_stats_families_json body (verbatim from 20260628000000_athlete_families.sql),
-- needed only to integration-test that a subscription charge flows through family aggregation
-- correctly (Phase 1 verified this by code-reading; this exercises it for real).

create table if not exists public.athlete_families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.athlete_family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.athlete_families(id) on delete cascade,
  user_id uuid references public.profiles(user_id) on delete cascade,
  manual_participant_id uuid references public.manual_participants(id) on delete cascade,
  created_at timestamptz not null default now()
);

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
