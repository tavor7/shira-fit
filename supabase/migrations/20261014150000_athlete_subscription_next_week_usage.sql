-- Athlete "My subscription": show next week's utilization next to this week's.
--
-- get_my_subscription keeps every existing field unchanged (older app builds keep working) and gains:
--   * weekly_usage[].extra  - sessions this week NOT covered by the subscription (charged as regular sessions after the
--                              athlete confirmed: allowance exceeded / frozen date / tier not included);
--   * next_week             - the immediately following Sunday-Saturday studio week:
--       week_start, week_end, window_days (Sun-Fri days the subscription is in its window), active_days (of those, not
--       frozen), frozen_days, and usage[] with the same per-tier fields as weekly_usage.
-- Every number reuses the existing engine, so next week is counted exactly like this week and like registration itself:
--   * effective_weekly_limit = subscription_effective_weekly_limit (prorates partial weeks: a subscription that starts,
--     ends, is stopped or frozen during the week, and version changes; 0 when the subscription is not active that week,
--     including while awaiting the athlete's terms consent);
--   * used  = the existing covered-registration count (active registrations + full-price late cancellations; cancelled
--     without charge and waitlist entries do not count; one coverage row per registration, so nothing is double counted);
--   * extra = the same population with covered = false and a subscription reason.
-- Studio week = Sunday-Saturday in the studio timezone (_studio_today_date, Asia/Jerusalem). Read-only; no data touched.
-- Aborts unless the deployed get_my_subscription is byte-identical to the reviewed one (md5 precondition).

do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.get_my_subscription()'::regprocedure) <> '38cb07ac1cf456bbdf323dcb8c62ef0d' then
    raise exception 'precondition: get_my_subscription differs from the reviewed version; refusing to replace it';
  end if;
end $$;

-- Per-tier usage of one subscription for one studio week (internal).
create or replace function public._subscription_week_usage(
  p_subscription_id uuid,
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_week_start date,
  p_tiers public.subscription_tier[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with counted as (
    select cov.tier, cov.covered
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    where cov.subscription_id = p_subscription_id
      and cov.week_start = p_week_start
      and (cov.covered = true or cov.non_coverage_reason in ('allowance_exceeded', 'frozen', 'tier_not_included'))
      and (
        cov.manual_participant_id is not null
        or reg.status = 'active'
        or exists (
          select 1 from public.cancellations c
          where c.session_id = reg.session_id and c.user_id = reg.user_id and c.charged_full_price is true
        )
      )
  ),
  rows as (
    select
      t.tier,
      coalesce((
        select max(ctx.weekly_limit)
        from generate_series(p_week_start, p_week_start + 5, interval '1 day') d,
             lateral public.subscription_effective_context(p_payee_id, p_payee_is_manual, d::date, t.tier) ctx
        where ctx.in_window
      ), 0) as configured_weekly_limit,
      public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, t.tier, p_week_start) as effective_weekly_limit,
      (select count(*) from counted c where c.tier = t.tier and c.covered) as used,
      (select count(*) from counted c where c.tier = t.tier and not c.covered) as extra,
      t.ord
    from unnest(p_tiers) with ordinality as t(tier, ord)
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', r.tier,
      'configured_weekly_limit', r.configured_weekly_limit,
      'effective_weekly_limit', r.effective_weekly_limit,
      'used', r.used,
      'extra', r.extra
    ) order by r.ord
  ), '[]'::jsonb)
  from rows r
  where r.configured_weekly_limit > 0 or r.effective_weekly_limit > 0 or r.used > 0 or r.extra > 0;
$$;
revoke execute on function public._subscription_week_usage(uuid, uuid, boolean, date, public.subscription_tier[]) from public, anon, authenticated;

-- Sun-Fri day counts for one studio week, same day range as subscription_effective_weekly_limit (internal).
create or replace function public._subscription_week_days(p_payee_id uuid, p_payee_is_manual boolean, p_week_start date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'window_days', count(*) filter (where ctx.in_window),
    'active_days', count(*) filter (where ctx.in_window and not ctx.is_frozen),
    'frozen_days', count(*) filter (where ctx.in_window and ctx.is_frozen)
  )
  from generate_series(p_week_start, p_week_start + 5, interval '1 day') d,
       lateral public.subscription_effective_context(p_payee_id, p_payee_is_manual, d::date, 'group'::public.subscription_tier) ctx;
$$;
revoke execute on function public._subscription_week_days(uuid, boolean, date) from public, anon, authenticated;

create or replace function public.get_my_subscription()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_version public.subscription_versions%rowtype;
  v_today date := public._studio_today_date();
  v_week_start date := v_today - extract(dow from v_today)::int;
  v_next_week_start date := v_week_start + 7;
  v_next_billing_date date;
  v_effective_plan_end_date date;
  v_current_freeze jsonb;
  v_upcoming_freeze jsonb;
  v_allowances jsonb;
  v_tiers public.subscription_tier[];
  v_usage jsonb;
  v_this_extra jsonb;
  v_next_usage jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select s.* into v_sub
  from public.subscriptions s
  where s.payee_id = v_uid
    and s.payee_is_manual = false
    and s.deleted_at is null
  order by s.created_at desc
  limit 1;

  if not found then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  select v.* into v_version
  from public.subscription_versions v
  where v.subscription_id = v_sub.id and v.effective_to is null
  limit 1;

  if not found or public.subscription_version_display_status(v_version.id, v_today) in ('stopped', 'completed') then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  v_next_billing_date := public.subscription_effective_next_billing_date(v_sub.id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version.id);

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_current_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and v_today between f.freeze_from and f.freeze_until
  limit 1;

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_upcoming_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and f.freeze_from > v_today
  order by f.freeze_from asc
  limit 1;

  select coalesce(jsonb_object_agg(a.tier::text, a.weekly_limit), '{}'::jsonb)
  into v_allowances
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

  -- This week: unchanged rows (current version's included tiers), each with `extra` added.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', a.tier,
      'configured_weekly_limit', a.weekly_limit,
      'effective_weekly_limit', public.subscription_effective_weekly_limit(v_sub.payee_id, false, a.tier, v_week_start),
      'used', coalesce((
        select count(*)
        from public.subscription_registration_coverage cov
        left join public.session_registrations reg on reg.id = cov.registration_id
        where cov.subscription_id = v_sub.id
          and cov.tier = a.tier
          and cov.week_start = v_week_start
          and cov.covered = true
          and (
            cov.manual_participant_id is not null
            or reg.status = 'active'
            or exists (
              select 1 from public.cancellations c
              where c.session_id = reg.session_id
                and c.user_id = reg.user_id
                and c.charged_full_price is true
            )
          )
      ), 0)
    )
    order by a.tier
  ), '[]'::jsonb)
  into v_usage
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

  select array_agg(t order by t) into v_tiers from unnest(enum_range(null::public.subscription_tier)) t;
  v_this_extra := public._subscription_week_usage(v_sub.id, v_sub.payee_id, false, v_week_start, v_tiers);
  select coalesce(jsonb_agg(
    u.row || jsonb_build_object('extra', coalesce((
      select (e->>'extra')::int from jsonb_array_elements(v_this_extra) e where e->>'tier' = u.row->>'tier'
    ), 0))
    order by u.ord
  ), '[]'::jsonb)
  into v_usage
  from jsonb_array_elements(v_usage) with ordinality as u(row, ord);

  v_next_usage := public._subscription_week_usage(v_sub.id, v_sub.payee_id, false, v_next_week_start, v_tiers);

  return json_build_object(
    'ok', true,
    'has_subscription', true,
    'is_frozen', v_current_freeze is not null,
    'monthly_price_ils', v_version.monthly_price_ils,
    'plan_start_date', v_version.plan_start_date,
    'plan_end_date', v_version.plan_end_date,
    'effective_plan_end_date', v_effective_plan_end_date,
    'has_no_end_date', v_version.has_no_end_date,
    'next_billing_date', v_next_billing_date,
    'current_freeze', v_current_freeze,
    'upcoming_freeze', v_upcoming_freeze,
    'week_start', v_week_start,
    'allowances', v_allowances,
    'weekly_usage', v_usage,
    'next_week', jsonb_build_object(
      'week_start', v_next_week_start,
      'week_end', v_next_week_start + 6,
      'usage', v_next_usage
    ) || public._subscription_week_days(v_sub.payee_id, false, v_next_week_start)
  );
end;
$$;

do $$
begin
  if not has_function_privilege('authenticated', 'public.get_my_subscription()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: get_my_subscription lost EXECUTE for authenticated';
  end if;
  if has_function_privilege('authenticated', 'public._subscription_week_usage(uuid,uuid,boolean,date,public.subscription_tier[])'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public._subscription_week_days(uuid,boolean,date)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: internal week helpers are client-executable';
  end if;
end $$;
