-- System monitoring: RPC-specific fingerprinting (20261028100000) and production/development occurrence
-- counters. Covers exactly the scenarios from the System Issues investigation and its approved fix:
--   - two different RPCs sharing the same error code must become two distinct issues (the bug found in
--     issue 4b90c582-d1d2-4314-9d02-74beadae404b: get_subscription_weekly_usage and
--     manager_get_archive_health both PGRST202, wrongly merged under the old fingerprint),
--   - the same RPC repeated must still group into one issue (no regression in existing dedup),
--   - a missing/invalid RPC name must fall back to the original fingerprint/title behaviour exactly,
--   - production vs development occurrence counts and last-seen timestamps must be independently correct,
--     including a single issue with occurrences in both environments,
--   - an occurrence with no env at all must not be silently counted as either and must mark the issue's
--     env history as no longer exact,
--   - _system_fingerprint itself must still have exactly one overload (no accidental ambiguity),
--   - existing deduplication/throttling (bucket counts) must be unaffected.
-- Self-contained: own fixtures, everything is rolled back. Uses the real allowlisted codes from the
-- investigation (PGRST202, 42883) so this exercises the exact production scenario, not a stand-in.
set client_min_messages to notice;
begin;

do $$
declare
  v_ath uuid;
  v_mgr uuid := gen_random_uuid();
  v_res jsonb;
  v_i1 public.system_issues;
  v_i2 public.system_issues;
  v_n bigint;
  v_fp1 text;
  v_fp2 text;
begin
  v_ath := gen_random_uuid();
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (v_ath, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't195-ath@test.local',
          jsonb_build_object('full_name', 't195 ath'), now(), now());
  update public.profiles set approval_status = 'approved' where user_id = v_ath;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (v_mgr, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't195-mgr@test.local',
          jsonb_build_object('full_name', 't195 mgr'), now(), now());
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';

  -- ===== E1: two different RPCs, same error code (the real investigated bug) =====
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', 'PGRST202',
    'context', jsonb_build_object('rpc', 'get_subscription_weekly_usage'), 'platform', 'web', 'env', 'prod'), v_ath);
  if not coalesce((v_res ->> 'accepted')::boolean, false) then raise exception 'E1 FAILED: report rejected: %', v_res; end if;
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', 'PGRST202',
    'context', jsonb_build_object('rpc', 'manager_get_archive_health'), 'platform', 'web', 'env', 'prod'), v_ath);
  if not coalesce((v_res ->> 'accepted')::boolean, false) then raise exception 'E1 FAILED: report rejected: %', v_res; end if;

  select count(*) into v_n from public.system_issues where error_code = 'PGRST202';
  if v_n <> 2 then raise exception 'E1 FAILED: expected 2 distinct issues for 2 RPCs sharing PGRST202, got %', v_n; end if;

  select * into v_i1 from public.system_issues where error_code = 'PGRST202' and operation_label = 'get_subscription_weekly_usage';
  select * into v_i2 from public.system_issues where error_code = 'PGRST202' and operation_label = 'manager_get_archive_health';
  if v_i1.id is null or v_i2.id is null then raise exception 'E1 FAILED: operation_label not set correctly on the two split issues'; end if;
  if v_i1.fingerprint = v_i2.fingerprint then raise exception 'E1 FAILED: the two RPCs still share a fingerprint'; end if;
  if v_i1.title not like '%get_subscription_weekly_usage%' or v_i2.title not like '%manager_get_archive_health%' then
    raise exception 'E1 FAILED: titles do not name the real RPC (% / %)', v_i1.title, v_i2.title;
  end if;
  raise notice 'E1 PASSED: two different RPCs sharing error code PGRST202 produced two distinct, correctly-titled issues';

  -- ===== E2: the same RPC repeated groups into the one issue (no dedup regression) =====
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', 'PGRST202',
    'context', jsonb_build_object('rpc', 'get_subscription_weekly_usage'), 'platform', 'web', 'env', 'prod'), v_ath);
  select count(*) into v_n from public.system_issues where operation_label = 'get_subscription_weekly_usage';
  if v_n <> 1 then raise exception 'E2 FAILED: repeat of the same RPC created a second issue (%)', v_n; end if;
  select occurrence_count into v_n from public.system_issues where operation_label = 'get_subscription_weekly_usage';
  if v_n <> 2 then raise exception 'E2 FAILED: occurrence_count expected 2, got %', v_n; end if;
  select fingerprint into v_fp1 from public.system_issues where operation_label = 'get_subscription_weekly_usage';
  if v_fp1 <> v_i1.fingerprint then raise exception 'E2 FAILED: fingerprint changed across repeats'; end if;
  raise notice 'E2 PASSED: repeated failures from the same RPC still group into one issue with a stable fingerprint';

  -- ===== E3: missing / invalid RPC name falls back to the original (pre-fix) behaviour exactly =====
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', '42883',
    'platform', 'web', 'env', 'prod'), v_ath); -- no context.rpc at all
  select * into v_i1 from public.system_issues where error_code = '42883' and operation_label is null;
  if v_i1.id is null then raise exception 'E3 FAILED: no-context.rpc report did not create an issue with null operation_label'; end if;
  if v_i1.fingerprint <> public._system_fingerprint('client', 'client', 'rpc/postgrest', 'PostgrestError', '42883', '', '') then
    raise exception 'E3 FAILED: fingerprint without an RPC name does not match the original formula';
  end if;

  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', '42883',
    'context', jsonb_build_object('rpc', 'not a valid name !!'), 'platform', 'web', 'env', 'prod'), v_ath); -- invalid shape
  select count(*) into v_n from public.system_issues where error_code = '42883';
  if v_n <> 1 then raise exception 'E3 FAILED: an invalid-shaped RPC name created a separate issue instead of falling back (%)', v_n; end if;
  raise notice 'E3 PASSED: a missing or invalid RPC name falls back to the original fingerprint/title exactly, no new issue';

  -- ===== E4: production vs development occurrence counts and last-seen are independently correct =====
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', 'PGRST202',
    'context', jsonb_build_object('rpc', 'manager_get_archive_health'), 'platform', 'web', 'env', 'dev'), v_ath);
  if not coalesce((v_res ->> 'accepted')::boolean, false) then raise exception 'E4 FAILED: dev report rejected: %', v_res; end if;
  select * into v_i2 from public.system_issues where operation_label = 'manager_get_archive_health';
  if v_i2.prod_occurrence_count <> 1 or v_i2.dev_occurrence_count <> 1 then
    raise exception 'E4 FAILED: expected prod=1 dev=1, got prod=% dev=%', v_i2.prod_occurrence_count, v_i2.dev_occurrence_count;
  end if;
  if v_i2.occurrence_count <> 2 then raise exception 'E4 FAILED: total occurrence_count expected 2, got %', v_i2.occurrence_count; end if;
  -- (same-transaction now() is constant, so equal timestamps here are expected -- what matters is both
  -- are independently populated, not that they differ)
  if v_i2.prod_last_seen is null or v_i2.dev_last_seen is null then
    raise exception 'E4 FAILED: prod_last_seen/dev_last_seen not independently tracked (% / %)', v_i2.prod_last_seen, v_i2.dev_last_seen;
  end if;
  if not v_i2.has_dev_occurrence then raise exception 'E4 FAILED: has_dev_occurrence should be true for a mixed-env issue'; end if;
  if not v_i2.env_history_complete then raise exception 'E4 FAILED: a fully-tracked mixed-env issue must still be env_history_complete'; end if;
  raise notice 'E4 PASSED: a single mixed-environment issue has correct, independent production and development counts and last-seen timestamps';

  -- ===== E5: an occurrence with no env at all is not silently counted as either, and marks history incomplete =====
  v_n := v_i2.occurrence_count;
  v_res := public._system_ingest('client', jsonb_build_object(
    'operation', 'rpc/postgrest', 'error_class', 'PostgrestError', 'error_code', 'PGRST202',
    'context', jsonb_build_object('rpc', 'manager_get_archive_health'), 'platform', 'web'), v_ath); -- env omitted
  select * into v_i2 from public.system_issues where operation_label = 'manager_get_archive_health';
  if v_i2.occurrence_count <> v_n + 1 then raise exception 'E5 FAILED: occurrence_count did not increment for an env-less report'; end if;
  if v_i2.prod_occurrence_count <> 1 or v_i2.dev_occurrence_count <> 1 then
    raise exception 'E5 FAILED: an env-less occurrence was wrongly counted toward prod or dev (prod=% dev=%)', v_i2.prod_occurrence_count, v_i2.dev_occurrence_count;
  end if;
  if v_i2.env_history_complete then raise exception 'E5 FAILED: env_history_complete should now be false (an occurrence''s env is unknown)'; end if;
  raise notice 'E5 PASSED: an occurrence with no env is excluded from both counters and honestly marks env history incomplete';

  -- ===== E6: _system_fingerprint itself still has exactly one overload (no ambiguity introduced) =====
  if (select count(*) from pg_proc where proname = '_system_fingerprint' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'E6 FAILED: _system_fingerprint must have exactly one overload';
  end if;
  raise notice 'E6 PASSED: _system_fingerprint has exactly one overload; the RPC-detail helper is a separate function';

  -- ===== E7: existing per-issue hourly bucket / breaker counting is unaffected by the new columns =====
  select count from public.system_issue_buckets where issue_id = v_i2.id and bucket_start = date_trunc('hour', now()) into v_n;
  if v_n is null or v_n < 1 then raise exception 'E7 FAILED: bucket count missing or zero for a reported issue'; end if;
  raise notice 'E7 PASSED: existing bucket/throttling counters still accumulate normally alongside the new env counters';

  -- ===== E8: a manager can read the new columns; a non-manager reads none of this issue's rows =====
  -- RLS is enforced by Postgres ROLE, not just the JWT claim -- set_config alone is not enough (the
  -- postgres superuser running this test bypasses RLS entirely); must actually switch role, same pattern
  -- as 138_system_monitoring_security_tests.sql's p_role helper.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.system_issues where id = v_i2.id and operation_label is not null) then
    raise exception 'E8 FAILED: an active manager cannot read operation_label on an existing issue';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ath, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.system_issues where id = v_i2.id) then
    raise exception 'E8 FAILED: a non-manager (athlete) can read a system_issues row';
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'E8 PASSED: manager-only visibility of the new columns is unchanged (RLS, not column grants, gates access)';

  raise notice 'ALL RPC-FINGERPRINT / ENV-SPLIT TESTS (E1-E8) PASSED';
end $$;

rollback;
