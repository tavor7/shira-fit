-- Subscription Management — athlete-facing read model.
--
-- Every existing subscription read RPC (list_active_subscriptions, list_subscription_history,
-- get_subscription_detail) is manager-only (is_manager() gated). subscription_effective_context()
-- itself is explicitly NOT exposed to authenticated callers because it takes an arbitrary
-- payee_id/payee_is_manual with no caller-identity check (see its comment in
-- 20260924100000_subscriptions_schema.sql) -- that comment calls out this exact gap: "A future
-- phase can add a properly-scoped (self-or-staff-only) read-only preview RPC that wraps this for
-- UI use." This migration adds that RPC, scoped strictly to auth.uid() (never a client-supplied
-- payee id), for the athlete "My Subscription" screen.
--
-- get_my_subscription() returns only what the calling athlete is allowed to see about their own
-- subscription: no subscription-version lineage, no billing ledger, no freeze/impact history, no
-- other payee's data. It reuses the exact same "current version" selection as
-- list_active_subscriptions, the exact same next-billing-date derivation
-- (subscription_next_anchor_date), and the exact same live coverage-counting predicate used by
-- subscription_reserve_or_reject() for weekly usage, so the number shown to the athlete can never
-- drift from the number the backend actually enforces at registration time.

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
  v_next_billing_date date;
  v_current_freeze jsonb;
  v_upcoming_freeze jsonb;
  v_allowances jsonb;
  v_usage jsonb;
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

  v_next_billing_date := public.subscription_next_anchor_date(
    v_version.anchor_day,
    coalesce(
      (select max(bp.period_start) from public.subscription_billing_periods bp where bp.subscription_id = v_sub.id),
      v_version.plan_start_date - 1
    )
  );

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

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', a.tier,
      'weekly_limit', a.weekly_limit,
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

  return json_build_object(
    'ok', true,
    'has_subscription', true,
    'is_frozen', v_current_freeze is not null,
    'monthly_price_ils', v_version.monthly_price_ils,
    'plan_start_date', v_version.plan_start_date,
    'plan_end_date', v_version.plan_end_date,
    'has_no_end_date', v_version.has_no_end_date,
    'next_billing_date', v_next_billing_date,
    'current_freeze', v_current_freeze,
    'upcoming_freeze', v_upcoming_freeze,
    'week_start', v_week_start,
    'allowances', v_allowances,
    'weekly_usage', v_usage
  );
end;
$$;

comment on function public.get_my_subscription() is
  'Athlete-safe self-read. Returns only the calling user''s own subscription summary (never '
  'another payee''s), scoped strictly via auth.uid() -- no client-supplied payee id, family member '
  'id, or manual-participant id is ever accepted. Mirrors list_active_subscriptions''s current-'
  'version selection and next-billing-date derivation, and subscription_reserve_or_reject''s live '
  'coverage-counting predicate for weekly usage, so figures shown here can never drift from what '
  'the backend actually enforces at registration time. Excludes version lineage, billing ledger, '
  'freeze/impact history, and any manager-only configuration -- those remain manager-only via '
  'get_subscription_detail.';

grant execute on function public.get_my_subscription() to authenticated;
