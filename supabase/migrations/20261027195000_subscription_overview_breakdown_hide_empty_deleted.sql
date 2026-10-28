-- Task 4: hide deleted subscriptions with zero financial activity from the Overview
-- "Subscriptions" card's expandable breakdown list (manager_subscription_overview_breakdown).
-- Presentation-only change: no subscription, charge, or payment row is created, modified, or
-- deleted. A deleted subscription stays visible whenever it has ANY real financial activity --
-- computed from the same unreversed-charges / unreversed-payments lateral joins this function
-- already used (not a possibly-netted "balance" field), so a subscription that was e.g. charged
-- 300 and paid 300 is correctly kept (real activity, net zero) while one that was created and
-- deleted with nothing ever posted or paid is hidden. Active (non-deleted) subscriptions are
-- always shown, unchanged from today.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_breakdown') <> 1 then
    raise exception 'precondition: manager_subscription_overview_breakdown must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_breakdown')
     <> '340a6d6e38f4eb74756205cb0c955efa' then
    raise exception 'precondition: source of manager_subscription_overview_breakdown differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.manager_subscription_overview_breakdown()
returns table (
  subscription_id uuid,
  payee_id uuid,
  payee_is_manual boolean,
  payee_display_name text,
  display_status text,
  is_deleted boolean,
  plan_start_date date,
  plan_end_date date,
  has_no_end_date boolean,
  charges_total_ils numeric,
  payments_total_ils numeric,
  outstanding_ils numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  return query
  select
    s.id,
    s.payee_id,
    s.payee_is_manual,
    coalesce(
      case when not s.payee_is_manual then p.full_name else mp.full_name end,
      '(unknown)'
    ),
    public.subscription_version_display_status(v.id, public._studio_today_date()),
    s.deleted_at is not null,
    v.plan_start_date,
    v.plan_end_date,
    v.has_no_end_date,
    coalesce(charges.total, 0),
    coalesce(payments.total, 0),
    coalesce(charges.total, 0) - coalesce(payments.total, 0)
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  left join lateral (
    select sum(c.amount_ils) as total
    from public.subscription_charges c
    where c.subscription_id = s.id
      and c.charge_type in ('recurring', 'proration')
      and not exists (select 1 from public.subscription_charges rv where rv.charge_type = 'reversal' and rv.reverses = c.id)
  ) charges on true
  left join lateral (
    select sum(a.amount_ils) as total
    from public.athlete_account_payments a
    where a.source_subscription_id = s.id
      and a.reversed_at is null
  ) payments on true
  where s.deleted_at is null
     or coalesce(charges.total, 0) <> 0
     or coalesce(payments.total, 0) <> 0
  order by s.created_at desc;
end;
$$;

comment on function public.manager_subscription_overview_breakdown() is
  'Manager-only. Per-subscription, all-time breakdown (every subscription that ever existed, including deleted ones, except deleted subscriptions with zero unreversed charges AND zero unreversed payments) backing the Subscriptions card''s expandable list on the manager Overview screen. Each shown row''s outstanding_ils is lifetime, same convention as manager_subscription_overview_stats.outstanding_ils. Lazily called (only when the manager expands the list), so it adds no cost to the default Overview load.';

grant execute on function public.manager_subscription_overview_breakdown() to authenticated;

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_breakdown') <> 1 then
    raise exception 'self-check: manager_subscription_overview_breakdown must exist exactly once';
  end if;
end $$;
