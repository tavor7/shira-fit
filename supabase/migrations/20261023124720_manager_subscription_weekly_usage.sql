-- Manager Subscription Detail: weekly session usage, with prev/next week navigation.
--
-- Adds a manager-only RPC, get_subscription_weekly_usage(p_subscription_id, p_week_start), that
-- reports the same per-tier usage numbers the athlete already sees in "My subscription"
-- (get_my_subscription / _subscription_week_usage, see 20261014150000_athlete_subscription_next_week_usage.sql)
-- but for an arbitrary studio week and authorized by manager role instead of auth.uid() = payee_id.
-- Reuses the existing internal engine unchanged -- used/extra/limit numbers are computed identically
-- to the athlete view and to booking-time enforcement, so the manager and athlete never disagree.
-- Read-only; no data touched.

create or replace function public.get_subscription_weekly_usage(p_subscription_id uuid, p_week_start date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_week_start date;
  v_tiers public.subscription_tier[];
  v_usage jsonb;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Normalize to that date's Sunday, same convention as get_my_subscription's v_week_start --
  -- callers are expected to pass a Sunday already, but any day in the week resolves correctly.
  v_week_start := p_week_start - extract(dow from p_week_start)::int;

  select array_agg(t order by t) into v_tiers from unnest(enum_range(null::public.subscription_tier)) t;
  v_usage := public._subscription_week_usage(v_sub.id, v_sub.payee_id, v_sub.payee_is_manual, v_week_start, v_tiers);

  return json_build_object(
    'ok', true,
    'week_start', v_week_start,
    'week_end', v_week_start + 6,
    'usage', v_usage
  ) || public._subscription_week_days(v_sub.payee_id, v_sub.payee_is_manual, v_week_start);
end;
$$;

comment on function public.get_subscription_weekly_usage(uuid, date) is
  'Manager-only. Per-tier session usage (used/extra vs. effective weekly limit) for one subscription '
  'for the studio week (Sun-Sat) containing p_week_start. Same engine as get_my_subscription, '
  'authorized by manager role instead of self-read.';

grant execute on function public.get_subscription_weekly_usage(uuid, date) to authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.get_subscription_weekly_usage(uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: get_subscription_weekly_usage lost EXECUTE for authenticated';
  end if;
end $$;
