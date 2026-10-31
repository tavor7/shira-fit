-- Managers currently have no way to correct a mistyped subscription start date, ever -- not a UI
-- oversight: edit_subscription_version() never accepts a plan_start_date parameter, and every new
-- version row it inserts explicitly copies v_current.plan_start_date forward unchanged (see
-- 20261026080552, lines inserting "plan_start_date, v_current.plan_start_date"). plan_start_date
-- and the anchor_day derived from it at create_subscription() time drive the monthly billing
-- anchor, partial-first-week allowance math and every subscription_registration_coverage decision
-- -- changing them for a subscription that already has billing periods, charges, payments,
-- freezes or coverage decisions would require recomputing all of that, which is a financial-policy
-- decision this migration deliberately does NOT make (tracked separately for manager approval).
--
-- This migration only covers the one scenario that is unambiguously safe: a subscription that is
-- still exactly as create_subscription() left it -- a single version (version_no = 1, never
-- superseded) with zero rows in every table a real subscription accumulates history in. There is
-- nothing to recompute in that case, so plan_start_date (and effective_from, which equals it for
-- version_no = 1) can simply be corrected in place. anchor_day is only recomputed when it was never
-- customized away from the default (i.e. it still equals the day-of-month of the OLD start date),
-- mirroring create_subscription()'s own "coalesce(p_anchor_day, extract(day from p_start_date))"
-- default -- an explicitly chosen custom anchor is left untouched, matching the "no silent
-- financial rewriting" rule even though no charges exist yet to rewrite.
create or replace function public.correct_subscription_start_date(
  p_subscription_id uuid,
  p_new_start_date date
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_has_history boolean;
  v_old_anchor_matched_default boolean;
  v_new_anchor smallint;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if v_current.plan_end_date is not null and v_current.plan_end_date < p_new_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;

  -- Must be the one and only version this subscription has ever had.
  if v_current.version_no <> 1 or v_current.superseded_by is not null then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'edited_version');
  end if;

  select exists (
    select 1 from public.subscription_freezes where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_billing_periods where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_charges where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_registration_coverage where subscription_id = p_subscription_id
    union all
    select 1 from public.athlete_account_payments where source_subscription_id = p_subscription_id
  ) into v_has_history;

  if v_has_history then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'financial_or_coverage_activity');
  end if;

  v_old_anchor_matched_default := v_current.anchor_day = extract(day from v_current.plan_start_date)::smallint;
  v_new_anchor := case when v_old_anchor_matched_default
    then extract(day from p_new_start_date)::smallint
    else v_current.anchor_day
  end;

  update public.subscription_versions
  set plan_start_date = p_new_start_date,
      effective_from = p_new_start_date,
      anchor_day = v_new_anchor
  where id = v_current.id;

  return json_build_object('ok', true, 'plan_start_date', p_new_start_date, 'anchor_day', v_new_anchor);
end;
$$;

comment on function public.correct_subscription_start_date(uuid, date) is
  'Manager-only. Corrects plan_start_date (and effective_from/anchor_day) for a brand-new '
  'subscription that has never been edited and has zero billing/charge/payment/freeze/coverage '
  'history -- returns ok:false/has_history for anything else, since that requires a financial-policy '
  'decision this function does not make.';

revoke execute on function public.correct_subscription_start_date(uuid, date) from public, anon;
grant execute on function public.correct_subscription_start_date(uuid, date) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.correct_subscription_start_date(uuid, date)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unexpected anon privilege on correct_subscription_start_date';
  end if;
end $$;
