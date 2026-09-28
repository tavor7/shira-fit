-- Phase 1/2 scoped tests, run as DO blocks that RAISE EXCEPTION on failure.
--
-- This repo has no pgTAP setup and no supabase/tests runner (checked: no pg_prove/pgtap in
-- migrations, no test script in package.json). These are plain scripted-assertion SQL files.
--
-- How to run (against a scratch Postgres — NOT the real project):
--   1. Load 00_stub_schema.sql (a minimal stand-in for the tables/functions the subscription
--      migrations depend on — profiles, training_sessions, session_registrations,
--      session_manual_participants, manual_participants, cancellations, athlete_account_payments,
--      plus stub is_manager/session_billing_price_ils/etc.). A full `supabase db reset` currently
--      fails before reaching these migrations on an unrelated, pre-existing historical migration
--      conflict (participant_registration_history return-type change in
--      20250330200000_registration_attendance.sql) — see the Phase 1/2 report for details.
--   2. Load ../migrations/20260924100000_subscriptions_schema.sql
--   3. Load ../migrations/20260924110000_subscriptions_atomic_registration.sql
--   4. Load this file.
--   5. For the concurrency scenario, load 20_concurrency_setup.sql, then run
--      21_concurrency_race_a.sql and 22_concurrency_race_b.sql concurrently (two psql
--      processes) and confirm exactly one returns ok:true.
--
-- All of the above was actually executed in a scratch `postgres:15` Docker container during
-- development of these migrations; every DO block below passed.
set client_min_messages to notice;

-- Fixtures --------------------------------------------------------------
do $$
declare
  v_coach uuid := gen_random_uuid();
  v_manager uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_no_sub uuid := gen_random_uuid();
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_coach, 'coach1', 'Coach One', '0500000001', 'coach', 'approved'),
    (v_manager, 'mgr1', 'Manager One', '0500000002', 'manager', 'approved'),
    (v_a, 'athlete_a', 'Athlete A', '0500000003', 'athlete', 'approved'),
    (v_b, 'athlete_b', 'Athlete B', '0500000004', 'athlete', 'approved'),
    (v_c, 'athlete_c', 'Athlete C', '0500000005', 'athlete', 'approved'),
    (v_no_sub, 'athlete_nosub', 'Athlete NoSub', '0500000006', 'athlete', 'approved');

  -- persist ids for later blocks via a temp table
  create table if not exists _test_ids (k text primary key, v uuid);
  insert into _test_ids values
    ('coach', v_coach), ('manager', v_manager), ('a', v_a), ('b', v_b), ('c', v_c), ('no_sub', v_no_sub);
end $$;

-- Test 1: regression — athlete with no subscription must be byte-for-byte unaffected.
do $$
declare
  v_a uuid; v_coach uuid; v_sess uuid; v_reg uuid;
  v_exp numeric; v_out numeric;
begin
  select v into v_a from _test_ids where k='a';
  select v into v_coach from _test_ids where k='coach';

  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants)
  values (gen_random_uuid(), current_date + 1, '10:00', v_coach, 2)
  returning id into v_sess;

  perform set_config('app.current_uid', v_a::text, true);
  perform public.register_for_session(v_sess);

  update public.session_registrations set attended = true where session_id = v_sess and user_id = v_a;

  select expected_ils, outstanding_ils into v_exp, v_out
  from public._period_merged_athlete_finance(current_date + 1, current_date + 1)
  where kind = 'app' and pid = v_a::text;

  if v_exp is distinct from 120.00 then
    raise exception 'TEST 1 FAILED: expected_ils should be 120 for non-subscriber, got %', v_exp;
  end if;
  if not exists (select 1 from public.subscription_registration_coverage where registration_id in (select id from session_registrations where session_id=v_sess and user_id=v_a)) then
    raise notice 'TEST 1 OK: no coverage row created for non-subscriber (correct)';
  else
    raise exception 'TEST 1 FAILED: a coverage row was created for a non-subscribed athlete';
  end if;
  raise notice 'TEST 1 PASSED: non-subscriber finance unaffected (expected_ils=%)', v_exp;
end $$;

-- Test 2: atomic registration — subscription with weekly_limit=2 for 'pair' tier; register A,B,C.
do $$
declare
  v_a uuid; v_b uuid; v_c uuid; v_coach uuid; v_manager uuid;
  v_sub uuid; v_ver uuid;
  v_week_sun date;
  v_sess1 uuid; v_sess2 uuid; v_sess3 uuid;
  v_res json;
begin
  select v into v_a from _test_ids where k='a';
  select v into v_b from _test_ids where k='b';
  select v into v_c from _test_ids where k='c';
  select v into v_coach from _test_ids where k='coach';
  select v into v_manager from _test_ids where k='manager';

  -- Sunday of a future week, to avoid _session_has_ended blocking registration.
  v_week_sun := (current_date + 14) - extract(dow from (current_date + 14))::int;

  insert into public.subscriptions (id, payee_id, payee_is_manual, created_by)
  values (gen_random_uuid(), v_a, false, v_manager) returning id into v_sub;

  insert into public.subscription_versions (id, subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (gen_random_uuid(), v_sub, 1, v_week_sun - 30, 300, 1, v_week_sun - 30) returning id into v_ver;

  insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
  values (v_ver, 'pair', 2);

  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants) values
    (gen_random_uuid(), v_week_sun + 5, '10:00', v_coach, 2) returning id into v_sess1; -- Friday
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants) values
    (gen_random_uuid(), v_week_sun + 6, '10:00', v_coach, 2) returning id into v_sess2; -- Saturday
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants) values
    (gen_random_uuid(), v_week_sun + 4, '10:00', v_coach, 2) returning id into v_sess3; -- Thursday

  -- A is the subscriber, registers Sunday (now) for Friday+Saturday sessions (consumes both slots).
  perform set_config('app.current_uid', v_a::text, true);
  v_res := public.register_for_session(v_sess1);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'TEST 2 FAILED: reg1 rejected: %', v_res; end if;
  v_res := public.register_for_session(v_sess2);
  if coalesce((v_res->>'ok')::boolean,false) is not true then raise exception 'TEST 2 FAILED: reg2 rejected: %', v_res; end if;

  -- Wednesday (later), A tries to register for Thursday's earlier-dated session -> should be
  -- allowance_exceeded since Fri/Sat already consumed the 2 slots via earlier registration order.
  v_res := public.register_for_session(v_sess3);
  if (v_res->>'ok')::boolean is true then
    raise exception 'TEST 2 FAILED: Thursday reg should have been rejected (allowance_exceeded), got %', v_res;
  end if;
  if v_res->>'reason' <> 'allowance_exceeded' then
    raise exception 'TEST 2 FAILED: expected reason allowance_exceeded, got %', v_res;
  end if;
  raise notice 'TEST 2a PASSED: registration-order priority correct, Thursday rejected: %', v_res;

  -- Confirm with accept_extra=true it proceeds as a paid extra.
  v_res := public.register_for_session(v_sess3, true);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'TEST 2 FAILED: accept_extra=true should have succeeded: %', v_res;
  end if;
  raise notice 'TEST 2b PASSED: accept_extra=true proceeds as paid extra';

  -- Verify coverage rows: Fri/Sat covered=true, Thu covered=false/allowance_exceeded.
  if (select count(*) from public.subscription_registration_coverage cov
        join public.session_registrations r on r.id = cov.registration_id
       where r.session_id in (v_sess1, v_sess2) and cov.covered = true) <> 2 then
    raise exception 'TEST 2 FAILED: expected Fri+Sat both covered=true';
  end if;
  if (select cov.covered from public.subscription_registration_coverage cov
        join public.session_registrations r on r.id = cov.registration_id
       where r.session_id = v_sess3) is not false then
    raise exception 'TEST 2 FAILED: expected Thursday covered=false';
  end if;
  raise notice 'TEST 2c PASSED: coverage rows correct';

  create table if not exists _test_ids2 (k text primary key, v uuid);
  insert into _test_ids2 values ('sub', v_sub), ('ver', v_ver), ('sess1', v_sess1), ('sess2', v_sess2), ('sess3', v_sess3), ('week_sun', null)
  on conflict do nothing;
end $$;

-- Test 3: reconciliation — cancel Friday (A) without charge -> Thursday's extra should NOT
-- backfill automatically via coverage-count re-derivation? Per plan: reallocation happens on
-- charge-decision flips (attended/no-show/cancellation charge flag), not on a plain future
-- cancellation with no charge decision recorded yet. Since Friday hasn't been attended/no-show
-- decided, cancelling it (status -> cancelled) should trigger reconcile because status changed,
-- and since Friday is no longer "chargeable" (status<>active, not charged_full_price), it drops
-- out of the ordered pass, freeing a slot that Thursday's already-covered=false row does NOT
-- automatically reclaim on its own trigger (Thursday's row didn't change) -- but reconcile_week
-- recomputes the whole week fresh, so Thursday's coverage should flip to covered=true.
do $$
declare
  v_sess1 uuid; v_sess3 uuid; v_a uuid;
  v_covered boolean;
begin
  select v into v_sess1 from _test_ids2 where k='sess1';
  select v into v_sess3 from _test_ids2 where k='sess3';
  select v into v_a from _test_ids where k='a';

  -- Cancel Friday without a charge. Thursday (still active, attended=null) is not yet
  -- "chargeable" so reconcile_week's gather predicate correctly leaves it untouched for now
  -- (matches _period_merged_athlete_finance: an unattended future registration owes nothing
  -- either way, so there is no financial inconsistency in the interim).
  update public.session_registrations
  set status = 'cancelled'
  where session_id = v_sess1 and user_id = v_a;

  -- Once Thursday's own attendance is recorded, ITS OWN trigger fires reconcile_week, which
  -- gathers chargeable registrations for the week fresh (Friday now excluded since cancelled
  -- without charge) and should reallocate Thursday into the freed slot.
  update public.session_registrations
  set attended = true
  where session_id = v_sess3 and user_id = v_a;

  select cov.covered into v_covered
  from public.subscription_registration_coverage cov
  join public.session_registrations r on r.id = cov.registration_id
  where r.session_id = v_sess3;

  if v_covered is not true then
    raise exception 'TEST 3 FAILED: Thursday should be reallocated covered=true once its own attendance flip triggers reconcile after Friday''s no-charge cancellation freed a slot, got %', v_covered;
  end if;
  raise notice 'TEST 3 PASSED: reconciliation reallocated Thursday to covered=true after cancellation + attendance flip';
end $$;

-- Test 4: finance function reflects covered=0 expected, and subscription_charges union works.
do $$
declare
  v_a uuid; v_sess2 uuid; v_ver uuid; v_sub uuid;
  v_bp uuid;
  v_exp numeric;
begin
  select v into v_a from _test_ids where k='a';
  select v into v_sess2 from _test_ids2 where k='sess2';
  select v into v_sub from _test_ids2 where k='sub';
  select v into v_ver from _test_ids2 where k='ver';

  update public.session_registrations set attended = true where session_id = v_sess2 and user_id = v_a;

  insert into public.subscription_billing_periods (id, subscription_id, version_id, period_start, period_end, raw_period_start, raw_period_end)
  values (
    gen_random_uuid(), v_sub, v_ver,
    (select session_date from training_sessions where id=v_sess2) - 5, (select session_date from training_sessions where id=v_sess2) + 25,
    (select session_date from training_sessions where id=v_sess2) - 5, (select session_date from training_sessions where id=v_sess2) + 25
  )
  returning id into v_bp;

  insert into public.subscription_charges (billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type)
  values (v_bp, v_sub, v_a, false, 300, 'recurring');

  select expected_ils into v_exp
  from public._period_merged_athlete_finance(
    (select session_date from training_sessions where id=v_sess2) - 5,
    (select session_date from training_sessions where id=v_sess2) + 25
  )
  where kind='app' and pid = v_a::text;

  -- Sess2 (Saturday, covered=true) contributes 0; sess3 (Thursday, now covered=true after test3)
  -- also contributes 0; the 300 recurring charge is the only expected line -> total should be 300.
  if v_exp <> 300.00 then
    raise exception 'TEST 4 FAILED: expected 300 (charge only, covered sessions zeroed), got %', v_exp;
  end if;
  raise notice 'TEST 4 PASSED: finance function zeroes covered sessions and adds charge (expected_ils=%)', v_exp;
end $$;

-- Test 5: frozen / tier_not_included warnings for a fresh subscriber.
do $$
declare
  v_b uuid; v_coach uuid; v_sub uuid; v_ver uuid; v_sess uuid; v_res json;
  v_day date := current_date + 21;
begin
  select v into v_b from _test_ids where k='b';
  select v into v_coach from _test_ids where k='coach';

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_b, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_day - 30, 300, 1, v_day - 30) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 0); -- personal/pair/group not included

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_day, '09:00', v_coach, 1) returning id into v_sess; -- personal tier, weekly_limit absent -> tier_not_included

  perform set_config('app.current_uid', v_b::text, true);
  v_res := public.register_for_session(v_sess);
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'tier_not_included' then
    raise exception 'TEST 5a FAILED: expected tier_not_included, got %', v_res;
  end if;
  raise notice 'TEST 5a PASSED: tier_not_included warning correct: %', v_res;

  -- Freeze covering this date, then a trio-tier session with an allowance, still frozen wins.
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 5)
  on conflict (version_id, tier) do update set weekly_limit = excluded.weekly_limit;
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until) values (v_sub, v_day, v_day);

  v_res := public.register_for_session(v_sess); -- already registered as paid extra from above call (ok=true path not taken though)
  -- Since previous call returned ok=false, nothing was inserted; try again now that tier IS included but frozen.
  if (v_res->>'ok')::boolean is true or v_res->>'reason' <> 'frozen' then
    raise exception 'TEST 5b FAILED: expected frozen, got %', v_res;
  end if;
  raise notice 'TEST 5b PASSED: frozen warning correct: %', v_res;
end $$;

-- Test 6: not_subscribed athlete gets zero subscription prompts (no reason key expected shape).
do $$
declare
  v_no_sub uuid; v_coach uuid; v_sess uuid; v_res json;
begin
  select v into v_no_sub from _test_ids where k='no_sub';
  select v into v_coach from _test_ids where k='coach';
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date + 22, '09:00', v_coach, 4) returning id into v_sess;

  perform set_config('app.current_uid', v_no_sub::text, true);
  v_res := public.register_for_session(v_sess);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'TEST 6 FAILED: not_subscribed athlete should register normally, got %', v_res;
  end if;
  if exists (select 1 from public.subscription_registration_coverage cov join session_registrations r on r.id=cov.registration_id where r.session_id=v_sess) then
    raise exception 'TEST 6 FAILED: not_subscribed athlete must not get a coverage row';
  end if;
  raise notice 'TEST 6 PASSED: not_subscribed athlete unaffected, no coverage row';
end $$;

do $$ begin raise notice 'ALL PHASE 1/2 SCOPED TESTS PASSED'; end $$;
