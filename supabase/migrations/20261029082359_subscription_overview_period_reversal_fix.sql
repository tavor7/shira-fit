-- Fix: manager_subscription_overview_stats's period-scoped charges_total_ils, and
-- manager_subscription_overview_breakdown's per-subscription charges_total_ils, only summed
-- charge_type in ('recurring', 'proration') -- silently excluding 'reversal' (and
-- 'freeze_credit' / 'stop_proration' / 'edit_correction') rows entirely. A subscription
-- charge posted and then reversed/corrected within the one reporting window (e.g. a
-- cancellation the same month it was billed) therefore overstated that period's/that
-- subscription's charges by the full gross original amount instead of netting to the true
-- financial effect.
--
-- Fix: sum every subscription_charges row unconditionally (no charge_type filter), matching
-- the convention _period_merged_athlete_finance and manager_weekly_stats_core already use.
-- This is safe because every charge-ledger row's amount_ils is already signed for its true
-- effect (reversal/correction rows are negative where they reduce what's owed -- see
-- subscription_generate_or_correct_billing_period and delete_subscription), and a reversal
-- always carries the SAME billing_period_id as the charge it reverses (never a different
-- one), so attributing by the charge's own billing period -- not by when the reversal was
-- recorded -- is correct for a period-scoped report and does not require a "lifetime" lookup
-- (not exists ... reverses) to avoid double-counting.
--
-- manager_subscription_overview_stats's v_lifetime_charges used that lifetime lookup
-- (filtered to recurring/proration, excluding any charge a reversal points at). For
-- recurring/proration pairs this is mathematically identical to summing every row (the
-- excluded original and its reversal already net to the same result as counting both), but
-- it silently ignored freeze_credit/stop_proration/edit_correction charges. Simplifying it to
-- the same unconditional sum keeps the function's own period and lifetime figures, and the
-- Dashboard's two subscription widgets (headline stats + per-subscription breakdown), using
-- one identical reconciliation rule instead of three subtly different ones.

create or replace function public.manager_subscription_overview_stats(p_start date, p_end date)
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_active_count int;
  v_charges_total numeric;
  v_payments_total numeric;
  v_lifetime_charges numeric;
  v_lifetime_payments numeric;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    return json_build_object('ok', false, 'error', 'invalid_range');
  end if;

  -- Point-in-time count, not period-scoped: "how many subscriptions are active right now".
  select count(*) into v_active_count
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) in ('active', 'frozen');

  -- Every charge-ledger row attributed to a billing period starting within the requested
  -- range (the "expected" side) -- unfiltered by charge_type so a reversal/correction posted
  -- in the same window as its original charge nets to the true effect, not the gross amount.
  select coalesce(sum(c.amount_ils), 0) into v_charges_total
  from public.subscription_charges c
  join public.subscription_billing_periods bp on bp.id = c.billing_period_id
  where bp.period_start between p_start and p_end;

  -- Subscription-tagged payments recorded within the requested range (the "collected" side) --
  -- same reversed_at exclusion as every other consumer of this table.
  select coalesce(sum(a.amount_ils), 0) into v_payments_total
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null
    and a.paid_at between p_start and p_end;

  -- Lifetime outstanding across every subscription (not period-scoped): every charge-ledger
  -- row ever posted, net of reversals/corrections by the same unconditional-sum convention
  -- as above. May be negative (overpayment credit) -- reported as-is, matching the existing
  -- outstanding_ils convention.
  select coalesce(sum(c.amount_ils), 0) into v_lifetime_charges
  from public.subscription_charges c;

  select coalesce(sum(a.amount_ils), 0) into v_lifetime_payments
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null;

  return json_build_object(
    'ok', true,
    'active_subscriptions_count', v_active_count,
    'charges_total_ils', v_charges_total,
    'payments_total_ils', v_payments_total,
    'outstanding_ils', v_lifetime_charges - v_lifetime_payments
  );
end;
$function$;

create or replace function public.manager_subscription_overview_breakdown()
 returns table(subscription_id uuid, payee_id uuid, payee_is_manual boolean, payee_display_name text, display_status text, is_deleted boolean, plan_start_date date, plan_end_date date, has_no_end_date boolean, charges_total_ils numeric, payments_total_ils numeric, outstanding_ils numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
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
  -- Unfiltered by charge_type -- see migration comment above (same fix as
  -- manager_subscription_overview_stats, for the same reason: a reversed/corrected charge
  -- must net to its true effect, not be silently dropped from the lifetime total).
  left join lateral (
    select sum(c.amount_ils) as total
    from public.subscription_charges c
    where c.subscription_id = s.id
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
$function$;
