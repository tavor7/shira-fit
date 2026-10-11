-- Security (SEC-1): revoke client EXECUTE on the internal subscription / billing functions.
--
-- These functions are server-side internals of the subscription engine. They are SECURITY DEFINER (owner postgres,
-- search_path = public) and perform NO caller authorization of their own -- authorization lives in the manager-only
-- public entry points that call them (create/edit/freeze/stop/reactivate/delete_subscription, the registration RPCs)
-- and in the pg_cron job. Supabase's default privileges nevertheless granted EXECUTE to PUBLIC, anon and
-- authenticated (an earlier `revoke all ... from public` on generate_due_subscription_charges left the explicit anon /
-- authenticated grants in place), so any client -- including a completely unauthenticated anon caller -- could call
-- them directly through the REST API (/rpc/...). Verified before this migration over a real `authenticator` connection:
--   subscription_generate_or_correct_billing_period  creates billing periods and charges for ANY subscription, version
--                                                     and dates (an anon call created a ₪300 charge for 2031);
--   generate_due_subscription_charges                runs the whole daily billing job;
--   invoke_generate_subscription_charges_edge        makes the database POST the billing job's secret to the edge
--                                                     function (i.e. triggers the job over HTTP);
--   subscription_reconcile_week / _reserve_or_reject rewrite registration coverage for any subscription / week;
--   subscription_compute_impact                      runs a full reconcile + billing correction in a subtransaction and
--                                                     returns registration ids, dates and prices (no persistent write);
--   subscription_billing_period_* / _effective_* / _total_frozen_days / _version_display_status
--                                                     read prices, schedules and freeze data of any subscription;
--   _period_merged_athlete_finance / _manager_weekly_stats_families_json
--                                                     return every athlete's charges, expected and collected amounts;
--   _subscription_reconcile_after_* / _validate_subscription_payee
--                                                     trigger functions (not callable as RPCs; revoked for hygiene).
--
-- Callers (audited against the live catalog): only SECURITY DEFINER functions owned by postgres (the public entry points
-- above, manager_weekly_stats, the registration/move/revert RPCs and the internal chain among these functions), the
-- table triggers (trigger execution does not check EXECUTE), the pg_cron job `generate-subscription-charges` (runs as
-- postgres, the owner) and the edge function generate-subscription-charges (service_role). A definer's inner calls are
-- checked against the function owner, and the owner keeps EXECUTE. No RLS policy or view references these functions and
-- no invoker-rights function calls them. Nothing in the mobile app calls them. service_role keeps its grant.
--
-- Pure privilege change: no function body, policy, table or data is touched. Mirrors 20261005160000.

revoke execute on function public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type) from public, anon, authenticated;
revoke execute on function public.generate_due_subscription_charges() from public, anon, authenticated;
revoke execute on function public.invoke_generate_subscription_charges_edge() from public, anon, authenticated;
revoke execute on function public.subscription_compute_impact(uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.subscription_reconcile_week(uuid, date, public.subscription_tier) from public, anon, authenticated;
revoke execute on function public.subscription_reserve_or_reject(uuid, boolean, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.subscription_billing_period_amount(uuid, date, date) from public, anon, authenticated;
revoke execute on function public.subscription_billing_period_segments(uuid, date, date) from public, anon, authenticated;
revoke execute on function public.subscription_effective_context(uuid, boolean, date, public.subscription_tier) from public, anon, authenticated;
revoke execute on function public.subscription_effective_next_billing_date(uuid) from public, anon, authenticated;
revoke execute on function public.subscription_effective_plan_end_date(uuid) from public, anon, authenticated;
revoke execute on function public.subscription_effective_weekly_limit(uuid, boolean, public.subscription_tier, date) from public, anon, authenticated;
revoke execute on function public.subscription_total_frozen_days(uuid, date) from public, anon, authenticated;
revoke execute on function public.subscription_version_display_status(uuid, date) from public, anon, authenticated;
revoke execute on function public._period_merged_athlete_finance(date, date) from public, anon, authenticated;
revoke execute on function public._manager_weekly_stats_families_json(date, date) from public, anon, authenticated;
revoke execute on function public._subscription_reconcile_after_cancellation_change() from public, anon, authenticated;
revoke execute on function public._subscription_reconcile_after_manual_participant_change() from public, anon, authenticated;
revoke execute on function public._subscription_reconcile_after_registration_change() from public, anon, authenticated;
revoke execute on function public._validate_subscription_payee() from public, anon, authenticated;

-- Self-check: abort if any internal is still client-executable, a legitimate entry point lost access, or the billing
-- job lost its server-side callers.
do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_fn in array array[
    'public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type)',
    'public.generate_due_subscription_charges()',
    'public.invoke_generate_subscription_charges_edge()',
    'public.subscription_compute_impact(uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb)',
    'public.subscription_reconcile_week(uuid, date, public.subscription_tier)',
    'public.subscription_reserve_or_reject(uuid, boolean, uuid, boolean)',
    'public.subscription_billing_period_amount(uuid, date, date)',
    'public.subscription_billing_period_segments(uuid, date, date)',
    'public.subscription_effective_context(uuid, boolean, date, public.subscription_tier)',
    'public.subscription_effective_next_billing_date(uuid)',
    'public.subscription_effective_plan_end_date(uuid)',
    'public.subscription_effective_weekly_limit(uuid, boolean, public.subscription_tier, date)',
    'public.subscription_total_frozen_days(uuid, date)',
    'public.subscription_version_display_status(uuid, date)',
    'public._period_merged_athlete_finance(date, date)',
    'public._manager_weekly_stats_families_json(date, date)',
    'public._subscription_reconcile_after_cancellation_change()',
    'public._subscription_reconcile_after_manual_participant_change()',
    'public._subscription_reconcile_after_registration_change()',
    'public._validate_subscription_payee()'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') then
        raise exception 'self-check: % is still executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;

  if not has_function_privilege('service_role', 'public.generate_due_subscription_charges()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('postgres', 'public.generate_due_subscription_charges()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: the billing job lost its server-side callers';
  end if;

  foreach v_fn in array array[
    'public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb)',
    'public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean)',
    'public.freeze_subscription(uuid, date, date, boolean)',
    'public.stop_subscription(uuid, date, boolean)',
    'public.reactivate_subscription(uuid, date, date)',
    'public.delete_subscription(uuid)',
    'public.get_my_subscription()',
    'public.get_subscription_detail(uuid)',
    'public.list_active_subscriptions()',
    'public.list_subscription_history()',
    'public.manager_weekly_stats(date, text)'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'self-check: expected entry point % does not exist', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: legitimate entry point % lost EXECUTE for authenticated', v_fn;
    end if;
  end loop;
end $$;
