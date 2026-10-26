-- Fix: get_subscription_weekly_usage fails on EVERY call with
--   ERROR 42883: operator does not exist: json || jsonb
-- Reproduced against production (read-only, rolled back) for subscription
-- 52be2192-a88d-4007-b0c7-b4c4b73e5ed9 (אפרת אל חדד, plan starting Sunday 2026-10-25).
--
-- Root cause: the function's final RETURN concatenates `json_build_object(...)` (type json) with
-- `public._subscription_week_days(...)` (type jsonb) via `||`. Postgres defines `jsonb || jsonb` but
-- has no `json || jsonb` (or `json || json`) operator at all, so this throws for every subscription,
-- every week, every manager -- not data-, timezone- or weekday-dependent. The sibling athlete-facing
-- function (get_my_subscription, 20261014150000) does the equivalent merge correctly with
-- `jsonb_build_object(...) || _subscription_week_days(...)`; this function used json_build_object
-- instead of jsonb_build_object for the piece that needed `||`, which this migration corrects to
-- match that already-correct pattern.
--
-- Fix: compute the merge in jsonb (where `||` is valid), cast the final jsonb result to json only at
-- the very end -- preserves the function's existing `returns json` signature exactly, so this is a
-- plain CREATE OR REPLACE with an unchanged parameter list and return type (no DROP FUNCTION needed,
-- no risk of an ambiguous overload). Every other line (authorization check, subscription lookup, week
-- normalization, SECURITY DEFINER, search_path, grants) is byte-for-byte unchanged from
-- 20261023124720_manager_subscription_weekly_usage.sql -- this migration touches that one broken
-- expression and nothing else. Purely a read-only reporting function: no table is written by this
-- function before or after the fix.

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

  return (
    jsonb_build_object(
      'ok', true,
      'week_start', v_week_start,
      'week_end', v_week_start + 6,
      'usage', v_usage
    ) || public._subscription_week_days(v_sub.payee_id, v_sub.payee_is_manual, v_week_start)
  )::json;
end;
$$;

comment on function public.get_subscription_weekly_usage(uuid, date) is
  'Manager-only. Per-tier session usage (used/extra vs. effective weekly limit) for one subscription '
  'for the studio week (Sun-Sat) containing p_week_start. Same engine as get_my_subscription, '
  'authorized by manager role instead of self-read. Fixed 20261026210000: the final jsonb/json '
  'concatenation now happens in jsonb (valid), cast to json only at the end -- the earlier version '
  'used json_build_object for that piece, which has no || operator against the jsonb '
  '_subscription_week_days result and failed on every call.';

-- Self-check: grants unchanged (still manager/authenticated-only, nothing newly exposed), the
-- unauthenticated/non-manager path still returns cleanly, AND -- the actual regression test for this
-- bug -- a real manager calling it for a real subscription no longer raises the json/jsonb operator
-- error and gets back a well-formed response. Uses whatever manager/subscription already exist on
-- this database (generic, not a hardcoded id) via the request.jwt.claims GUC auth.uid() reads, the
-- same mechanism a real PostgREST call uses -- no role switch needed, this DO block already runs with
-- sufficient privilege to set that GUC locally to this transaction.
do $$
declare
  v_probe json;
  v_manager uuid;
  v_sub_id uuid;
begin
  if not has_function_privilege('authenticated', 'public.get_subscription_weekly_usage(uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: get_subscription_weekly_usage lost EXECUTE for authenticated';
  end if;

  -- Unauthenticated/non-manager: must still cleanly return the forbidden JSON, not an exception.
  perform set_config('request.jwt.claims', '', true);
  select public.get_subscription_weekly_usage((select id from public.subscriptions limit 1), current_date) into v_probe;
  if v_probe->>'ok' <> 'false' or v_probe->>'error' <> 'forbidden' then
    raise exception 'self-check: unexpected result calling as non-manager (got %)', v_probe;
  end if;

  -- The actual bug: a real manager, a real subscription, the exact expression that used to throw
  -- "operator does not exist: json || jsonb" on every single call.
  select user_id into v_manager from public.profiles where role = 'manager' and disabled_at is null limit 1;
  select id into v_sub_id from public.subscriptions where deleted_at is null limit 1;
  if v_manager is not null and v_sub_id is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_manager)::text, true);
    select public.get_subscription_weekly_usage(v_sub_id, current_date) into v_probe;
    if v_probe->>'ok' <> 'true' or v_probe->'week_start' is null or v_probe->'usage' is null
       or v_probe->'window_days' is null then
      raise exception 'self-check: get_subscription_weekly_usage did not return a well-formed success response (got %)', v_probe;
    end if;
  end if;
  perform set_config('request.jwt.claims', '', true);
end $$;
