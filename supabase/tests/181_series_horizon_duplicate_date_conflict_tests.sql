-- Regression tests for 20261021100000_fix_series_horizon_duplicate_date_conflict.sql and
-- 20261021110000_series_horizon_system_issues_reporting.sql.
--
-- Root cause covered: a detached ("this occurrence only") session keeps its series_id by
-- design (Stage 1), but when its coach/start_time no longer match the series' CURRENT
-- template, the old physical pre-existence check in _generate_series_occurrence_claim could
-- not see it, so the claim re-inserted a training_sessions row for the same
-- (series_id, session_date) and hit training_sessions_series_date_uidx -- a constraint name
-- the exception handler did not recognize. That aborted the whole per-series while-loop
-- (the EXCEPTION block is a savepoint around the loop, not one iteration), silently stopping
-- that series from reaching any later date in the same horizon run, and was never surfaced
-- to System Issues even though it was a genuine recurring production failure (series
-- 8714c05d, 282 occurrences 2026-10-15..19 in the originating investigation).
--
-- Uses its own fixtures (manager + 2 coaches) so it does not depend on fixture tables
-- created by earlier numbered test files.
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach1 uuid := gen_random_uuid();
  v_coach2 uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values
    (v_manager, 'series181-manager@t.local', '0500000301'),
    (v_coach1, 'series181-coach1@t.local', '0500000302'),
    (v_coach2, 'series181-coach2@t.local', '0500000303')
  ) u(id, e, p);

  update public.profiles set approval_status = 'approved', role = 'manager' where user_id = v_manager;
  update public.profiles set approval_status = 'approved', role = 'coach' where user_id in (v_coach1, v_coach2);

  create table if not exists _test181_ids (k text primary key, v uuid);
  insert into _test181_ids values ('manager', v_manager), ('coach1', v_coach1), ('coach2', v_coach2)
  on conflict (k) do update set v = excluded.v;
end $$;

-- TEST 1: existing detached session, DIFFERENT coach and start_time than the series' current
-- template -- the exact production shape (series 8714c05d / 2026-10-20). Must be recognized
-- by (series_id, session_date) and short-circuit to already_handled; no second row, no error.
do $$
declare
  v_coach1 uuid; v_coach2 uuid;
  v_series uuid; v_target date := current_date + 901;
  v_detached_id uuid; v_claim_result text; v_count int;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  select v into v_coach2 from _test181_ids where k='coach2';

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_target, '19:00', 6, 'ongoing', 'active') returning id into v_series;

  -- Legacy-shaped detached row: keeps series_id, but a different coach AND a different time,
  -- no ledger row -- exactly what a "this occurrence only" edit made before Stage 1 (or any
  -- edit path that doesn't establish a ledger claim) leaves behind.
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, series_id, series_detached)
  values (v_target, '09:00', v_coach2, 6, v_series, true) returning id into v_detached_id;

  v_claim_result := public._generate_series_occurrence_claim(v_series, v_target);
  if v_claim_result <> 'already_handled' then
    raise exception 'TEST1 FAILED: expected already_handled, got %', v_claim_result;
  end if;

  select count(*) into v_count from public.training_sessions where series_id = v_series and session_date = v_target;
  if v_count <> 1 then
    raise exception 'TEST1 FAILED: expected exactly 1 session for (series, date), found %', v_count;
  end if;
  if not exists (select 1 from public.training_sessions where id = v_detached_id and coach_id = v_coach2 and start_time = '09:00' and series_detached) then
    raise exception 'TEST1 FAILED: the detached session was modified';
  end if;

  raise notice 'TEST1 PASSED: detached session (different coach+time) recognized by (series_id, date), no duplicate created';
end $$;

-- TEST 2: existing detached session with coach and start_time UNCHANGED from the series'
-- current template -- the original physical-slot short-circuit already covered this; confirm
-- it is unaffected by the fix (regression guard).
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_target date := current_date + 902;
  v_detached_id uuid; v_claim_result text; v_count int;
begin
  select v into v_coach1 from _test181_ids where k='coach1';

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_target, '19:00', 6, 'ongoing', 'active') returning id into v_series;

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, series_id, series_detached)
  values (v_target, '19:00', v_coach1, 6, v_series, true) returning id into v_detached_id;

  v_claim_result := public._generate_series_occurrence_claim(v_series, v_target);
  if v_claim_result <> 'already_handled' then
    raise exception 'TEST2 FAILED: expected already_handled, got %', v_claim_result;
  end if;

  select count(*) into v_count from public.training_sessions where series_id = v_series and session_date = v_target;
  if v_count <> 1 then raise exception 'TEST2 FAILED: expected exactly 1 session, found %', v_count; end if;

  raise notice 'TEST2 PASSED: detached session (unchanged coach+time) still already_handled';
end $$;

-- TEST 3: series template edited AFTER an occurrence was generated and then detached under
-- the OLD template -- reproduces the production timeline (session_series.updated_at moved
-- after the conflicting session existed). The detached row is never touched; the next
-- horizon pass for that date is a no-op, not a failure.
do $$
declare
  v_coach1 uuid; v_coach2 uuid;
  v_series uuid; v_target date := current_date + 903;
  v_sess_id uuid; v_claim_result text;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  select v into v_coach2 from _test181_ids where k='coach2';

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_target, '18:00', 6, 'ongoing', 'active') returning id into v_series;

  -- Generated under the OLD template.
  v_claim_result := public._generate_series_occurrence_claim(v_series, v_target);
  if v_claim_result <> 'created' then raise exception 'TEST3 SETUP FAILED: expected created, got %', v_claim_result; end if;
  select id into v_sess_id from public.training_sessions where series_id = v_series and session_date = v_target;

  -- This occurrence gets detached and reassigned (coach change), independent of the series.
  update public.training_sessions set coach_id = v_coach2, series_detached = true where id = v_sess_id;

  -- The series' template itself is edited later (start_time change), same shape as the real
  -- 2026-10-14 edit on series 8714c05d.
  update public.session_series set start_time = '19:00' where id = v_series;

  -- Horizon maintenance revisits this date under the NEW template: must recognize the
  -- detached row by series_id+date and do nothing, not fail.
  v_claim_result := public._generate_series_occurrence_claim(v_series, v_target);
  if v_claim_result <> 'already_handled' then
    raise exception 'TEST3 FAILED: expected already_handled after template edit, got %', v_claim_result;
  end if;
  if not exists (select 1 from public.training_sessions where id = v_sess_id and coach_id = v_coach2 and series_detached) then
    raise exception 'TEST3 FAILED: detached+reassigned session was altered';
  end if;

  raise notice 'TEST3 PASSED: template edit after detach does not resurrect or fail on the vacated date';
end $$;

-- TEST 4: horizon generation continues to subsequent dates after a handled conflict on an
-- earlier date, within a single _maintain_session_series_horizon_core() run -- this is the
-- actual production-impact fix: before, the whole per-series while-loop died on the first
-- unresolved date and never reached later, otherwise-generatable dates.
do $$
declare
  v_coach1 uuid; v_coach2 uuid;
  v_series uuid; v_d1 date := current_date + 1; v_d2 date := current_date + 8;
  v_result json;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  select v into v_coach2 from _test181_ids where k='coach2';

  -- Anchor so v_d1 is the FIRST candidate date (today+1), v_d2 one week later; both inside
  -- the default 35-day horizon.
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_d1, '20:00', 6, 'ongoing', 'active') returning id into v_series;

  -- Plant the exact TEST1 conflict on the FIRST date only.
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, series_id, series_detached)
  values (v_d1, '08:00', v_coach2, 6, v_series, true);

  select public._maintain_session_series_horizon_core() into v_result;

  if (v_result->>'failed')::int <> 0 then
    raise exception 'TEST4 FAILED: horizon run reported % failures, expected 0 (handled conflicts never fail)', v_result->>'failed';
  end if;
  if not exists (select 1 from public.training_sessions where series_id = v_series and session_date = v_d2 and coach_id = v_coach1) then
    raise exception 'TEST4 FAILED: the later, unrelated date was NOT generated -- the per-series loop still dies early';
  end if;

  raise notice 'TEST4 PASSED: horizon generation reached the later date after a handled conflict on the earlier one';
end $$;

-- TEST 5: retry / concurrency race -- a second claim attempt for the same (series, date)
-- after the first has already committed it must be idempotent, not an error.
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_target date := current_date + 905;
  v_r1 text; v_r2 text; v_count int;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_target, '21:00', 6, 'ongoing', 'active') returning id into v_series;

  v_r1 := public._generate_series_occurrence_claim(v_series, v_target);
  v_r2 := public._generate_series_occurrence_claim(v_series, v_target);
  if v_r1 <> 'created' then raise exception 'TEST5 FAILED: first claim expected created, got %', v_r1; end if;
  if v_r2 <> 'already_handled' then raise exception 'TEST5 FAILED: retried claim expected already_handled, got %', v_r2; end if;

  select count(*) into v_count from public.training_sessions where series_id = v_series and session_date = v_target;
  if v_count <> 1 then raise exception 'TEST5 FAILED: expected exactly 1 session after retry, found %', v_count; end if;

  raise notice 'TEST5 PASSED: a retried claim for an already-materialized date is idempotent';
end $$;

-- TEST 6, 7, 8: genuinely unexpected database errors must still propagate to the per-series
-- handler (never silently classified as a handled outcome), and must be visible in System
-- Issues, deduplicated by fingerprint. Simulated with a scratch unique index the claim
-- function has no knowledge of, scoped to is_kickbox=true so it only ever engages for series
-- this test file deliberately flags that way (never colliding with earlier tests' fixtures,
-- which are all is_kickbox=false/default) -- a stand-in for any future unrecognized
-- constraint, which is exactly the bug class this migration closes for the one constraint it
-- does know about.
do $$ begin
  create unique index _test181_scratch_uidx on public.training_sessions (series_id) where series_id is not null and is_kickbox;
exception when duplicate_table then null; end $$;

-- TEST 6: the error propagates out of _generate_series_occurrence_claim uncaught (not
-- returned as a recognized outcome).
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_d1 date := current_date + 906; v_d2 date := current_date + 913;
  v_r1 text; v_raised boolean := false;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, duration_minutes, is_kickbox, repeat_mode, status)
  values (v_coach1, v_d1, '22:00', 6, 60, true, 'ongoing', 'active') returning id into v_series;

  v_r1 := public._generate_series_occurrence_claim(v_series, v_d1);
  if v_r1 <> 'created' then raise exception 'TEST6 SETUP FAILED: expected created, got %', v_r1; end if;

  begin
    perform public._generate_series_occurrence_claim(v_series, v_d2);
    raise exception 'TEST6 FAILED: second occurrence should have raised on the scratch unique index, returned normally instead';
  exception
    when unique_violation then v_raised := true;
    when others then raise exception 'TEST6 FAILED: expected unique_violation, got SQLSTATE %', sqlstate;
  end;
  if not v_raised then raise exception 'TEST6 FAILED: no exception observed'; end if;
  if exists (select 1 from public.session_series_occurrences where series_id = v_series and template_occurrence_date = v_d2) then
    raise exception 'TEST6 FAILED: a ledger row survived the failed, unrecognized-constraint materialization attempt';
  end if;

  raise notice 'TEST6 PASSED: an unrecognized unique_violation propagates uncaught, no ledger row left behind';
end $$;

-- TEST 7: the same genuine failure, reached through the full horizon run, is recorded in
-- Activity Log AND reported to System Issues with identifying context.
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_d1 date := current_date + 2; v_d2 date := current_date + 9;
  v_result json; v_issue record;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, duration_minutes, is_kickbox, repeat_mode, status)
  values (v_coach1, v_d1, '23:00', 6, 45, true, 'ongoing', 'active') returning id into v_series;

  -- First date generates fine; the scratch index then blocks the second date for this series.
  select public._maintain_session_series_horizon_core() into v_result;
  if (v_result->>'failed')::int < 1 then
    raise exception 'TEST7 FAILED: expected at least 1 reported failure, got %', v_result->>'failed';
  end if;

  if not exists (
    select 1 from public.user_activity_events
    where event_type = 'series_horizon_generation_failed' and target_id = v_series::text
  ) then
    raise exception 'TEST7 FAILED: no series_horizon_generation_failed activity event logged';
  end if;

  select * into v_issue from public.system_issues
  where fingerprint = md5('key' || chr(31) || 'series_horizon_generation_failed:' || v_series::text);
  if not found then
    raise exception 'TEST7 FAILED: no System Issues row created for the genuine failure';
  end if;
  if v_issue.status <> 'open' then raise exception 'TEST7 FAILED: expected status open, got %', v_issue.status; end if;
  if v_issue.source <> 'cron' or v_issue.operation <> 'maintain_session_series_horizon' then
    raise exception 'TEST7 FAILED: unexpected source/operation (%/ %)', v_issue.source, v_issue.operation;
  end if;

  raise notice 'TEST7 PASSED: a genuine series-generation failure is logged AND reported to System Issues';
end $$;

-- TEST 8: repeated identical failures across runs update the SAME issue and increment its
-- occurrence count, rather than creating a new issue each time.
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_d1 date := current_date + 3; v_d2 date := current_date + 10;
  v_issue_id_1 uuid; v_issue_id_2 uuid; v_count_1 bigint; v_count_2 bigint;
  v_fp text;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, duration_minutes, is_kickbox, repeat_mode, status)
  values (v_coach1, v_d1, '06:30', 6, 50, true, 'ongoing', 'active') returning id into v_series;
  v_fp := md5('key' || chr(31) || 'series_horizon_generation_failed:' || v_series::text);

  perform public._maintain_session_series_horizon_core();
  select id, occurrence_count into v_issue_id_1, v_count_1 from public.system_issues where fingerprint = v_fp;
  if v_issue_id_1 is null then raise exception 'TEST8 SETUP FAILED: no issue created on first run'; end if;

  perform public._maintain_session_series_horizon_core();
  select id, occurrence_count into v_issue_id_2, v_count_2 from public.system_issues where fingerprint = v_fp;

  if v_issue_id_2 <> v_issue_id_1 then
    raise exception 'TEST8 FAILED: second run created a different issue (% vs %) instead of updating the same one', v_issue_id_2, v_issue_id_1;
  end if;
  if v_count_2 <= v_count_1 then
    raise exception 'TEST8 FAILED: occurrence_count did not increase (% -> %)', v_count_1, v_count_2;
  end if;
  if (select count(*) from public.system_issues where fingerprint = v_fp) <> 1 then
    raise exception 'TEST8 FAILED: more than one System Issues row exists for this fingerprint';
  end if;

  raise notice 'TEST8 PASSED: repeated failures deduplicate to one issue, occurrence_count % -> %', v_count_1, v_count_2;
end $$;

drop index if exists public._test181_scratch_uidx;

-- TEST 9: a successfully handled conflict (TEST1's shape) must never create a System Issue.
do $$
declare
  v_coach1 uuid; v_coach2 uuid;
  v_series uuid; v_target date := current_date + 909;
  v_fp text;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  select v into v_coach2 from _test181_ids where k='coach2';

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode, status)
  values (v_coach1, v_target, '17:00', 6, 'ongoing', 'active') returning id into v_series;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, series_id, series_detached)
  values (v_target, '05:00', v_coach2, 6, v_series, true);
  v_fp := md5('key' || chr(31) || 'series_horizon_generation_failed:' || v_series::text);

  perform public._maintain_session_series_horizon_core();

  if exists (select 1 from public.system_issues where fingerprint = v_fp) then
    raise exception 'TEST9 FAILED: a handled conflict created a System Issue';
  end if;
  if exists (select 1 from public.user_activity_events where event_type = 'series_horizon_generation_failed' and target_id = v_series::text) then
    raise exception 'TEST9 FAILED: a handled conflict was logged as a generation failure';
  end if;

  raise notice 'TEST9 PASSED: a successfully handled conflict reports nothing to System Issues or the failure log';
end $$;

-- TEST 10: disabling monitoring ingestion entirely must not interfere with business
-- operations -- the generation/conflict-handling result is identical whether or not
-- reporting succeeds (_report_system_error already never raises; this proves the business
-- path does not even notice).
do $$
declare
  v_coach1 uuid;
  v_series uuid; v_d1 date := current_date + 4; v_d2 date := current_date + 11;
  v_before jsonb; v_result json;
begin
  select v into v_coach1 from _test181_ids where k='coach1';
  select value into v_before from public.system_monitoring_config where key = 'ingest_enabled';

  update public.system_monitoring_config set value = 'false'::jsonb where key = 'ingest_enabled';

  begin
    create unique index _test181_scratch_uidx2 on public.training_sessions (series_id) where series_id is not null and is_hidden;
  exception when duplicate_table then null; end;

  insert into public.session_series (coach_id, anchor_date, start_time, max_participants, duration_minutes, is_hidden, repeat_mode, status)
  values (v_coach1, v_d1, '06:45', 6, 40, true, 'ongoing', 'active') returning id into v_series;

  select public._maintain_session_series_horizon_core() into v_result;

  if (v_result->>'failed')::int < 1 then
    raise exception 'TEST10 FAILED: expected the business-level failure to still be recorded with ingest disabled, got failed=%', v_result->>'failed';
  end if;
  if not exists (select 1 from public.user_activity_events where event_type = 'series_horizon_generation_failed' and target_id = v_series::text) then
    raise exception 'TEST10 FAILED: Activity Log stopped working when monitoring ingestion was disabled';
  end if;
  if exists (
    select 1 from public.system_issues
    where fingerprint = md5('key' || chr(31) || 'series_horizon_generation_failed:' || v_series::text)
  ) then
    raise exception 'TEST10 FAILED: a System Issue was created despite ingest_enabled=false';
  end if;

  drop index if exists public._test181_scratch_uidx2;
  update public.system_monitoring_config set value = coalesce(v_before, 'true'::jsonb) where key = 'ingest_enabled';

  raise notice 'TEST10 PASSED: business logic (generation + Activity Log) is unaffected by disabled monitoring ingestion';
end $$;

do $$ begin raise notice 'ALL SERIES-HORIZON DUPLICATE-DATE-CONFLICT TESTS PASSED'; end $$;
