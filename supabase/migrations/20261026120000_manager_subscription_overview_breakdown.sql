-- Phase 3B: per-subscription breakdown backing the Subscriptions card's new expandable list (manager
-- Overview screen). Deliberately a separate, lazily-called RPC (fetched only when the manager expands
-- the section, same pattern as "From Athletes" -> "Show balances") rather than folded into
-- manager_subscription_overview_stats, so collapsed-by-default Overview loads never pay for it.
--
-- All-time by design, matching manager_subscription_overview_stats's own "Outstanding (all time)"
-- convention, NOT the period-scoped Charges/Payments cards -- so this is the one view where every
-- row's outstanding_ils sums to exactly the summary card's outstanding_ils, with no ambiguity about
-- which window is being shown (see the migration this depends on's own comment about not mixing
-- period-specific totals with all-time balances without an explicit label; the UI layer is
-- responsible for labeling this list "all time").
--
-- Covers every subscription that has ever existed (active, frozen, stopped, completed, scheduled,
-- AND deleted/tombstoned) by combining the same two queries list_active_subscriptions /
-- list_subscription_history already use (reused verbatim for payee-name resolution and status), so a
-- manager can always find the subscription behind any line item in the summary card, including one
-- that was later deleted.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_breakdown') > 0 then
    raise exception 'precondition: manager_subscription_overview_breakdown must not already exist';
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
  order by s.created_at desc;
end;
$$;

comment on function public.manager_subscription_overview_breakdown() is
  'Manager-only. Per-subscription, all-time breakdown (every subscription that ever existed, including deleted ones) backing the Subscriptions card''s expandable list on the manager Overview screen. Each row''s outstanding_ils is lifetime, same convention as manager_subscription_overview_stats.outstanding_ils, and the rows sum to exactly that figure -- not to the period-scoped charges_total_ils/payments_total_ils on the summary card. Lazily called (only when the manager expands the list), so it adds no cost to the default Overview load.';

grant execute on function public.manager_subscription_overview_breakdown() to authenticated;

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_subscription_overview_breakdown') <> 1 then
    raise exception 'self-check: manager_subscription_overview_breakdown must exist exactly once';
  end if;
end $$;
