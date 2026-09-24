-- Phase 3 billing-engine tests, batch 4: finance-function integration, reversal netting,
-- family roll-up, non-subscriber regression.
set client_min_messages to notice;

-- Test B13: a subscription charge appears exactly once in _period_merged_athlete_finance for
-- its period (the period whose bp.period_start falls in the query range), with no double-count.
do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date; v_bp_id uuid; v_end date;
  v_exp numeric;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_b13', 'Athlete B13', '0500001013', 'athlete', 'approved');

  v_start := current_date - 5;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  perform public.generate_due_subscription_charges();
  select id, period_end into v_bp_id, v_end from subscription_billing_periods where subscription_id=v_sub and period_start=v_start;

  select expected_ils into v_exp from public._period_merged_athlete_finance(v_start, v_start)
  where kind='app' and pid=v_p::text;
  if v_exp <> 300 then raise exception 'B13 FAILED: expected 300 when querying exactly the period-start date, got %', v_exp; end if;

  -- Querying a range that does NOT include period_start must NOT show the charge (attributed
  -- once, to whichever range contains bp.period_start -- confirms no double-count/smearing).
  select expected_ils into v_exp from public._period_merged_athlete_finance(v_start + 1, v_end - 1)
  where kind='app' and pid=v_p::text;
  if v_exp is not null and v_exp <> 0 then
    raise exception 'B13 FAILED: charge should not appear when the range excludes period_start, got %', v_exp;
  end if;

  -- Querying a WIDE range covering the whole period must still show it exactly once (not
  -- multiplied by how many days of overlap).
  select expected_ils into v_exp from public._period_merged_athlete_finance(v_start, v_end) where kind='app' and pid=v_p::text;
  if v_exp <> 300 then raise exception 'B13 FAILED: wide range should still show exactly 300 once, got %', v_exp; end if;

  raise notice 'B13 PASSED: subscription charge appears exactly once, attributed to the range containing period_start';

  create table if not exists _billing_ids4 (k text primary key, v uuid);
  insert into _billing_ids4 values ('b13_p', v_p), ('b13_sub', v_sub), ('b13_ver', v_ver), ('b13_bp', v_bp_id)
  on conflict do nothing;
end $$;

-- Test B14: reversal aggregates correctly against the original in the finance sum.
do $$
declare
  v_p uuid; v_sub uuid; v_bp_id uuid; v_start date; v_end date; v_exp numeric; v_freeze_id uuid;
begin
  select v into v_p from _billing_ids4 where k='b13_p';
  select v into v_sub from _billing_ids4 where k='b13_sub';
  select v into v_bp_id from _billing_ids4 where k='b13_bp';
  select period_start, period_end into v_start, v_end from subscription_billing_periods where id=v_bp_id;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_start + 2, v_start + 6)
  returning id into v_freeze_id;

  perform public.subscription_generate_or_correct_billing_period(
    v_sub, (select id from subscription_versions where subscription_id=v_sub), v_start, v_end, v_freeze_id, 'freeze_credit'
  );

  -- Finance function sums ALL subscription_charges rows for the period (original 300 + reversal
  -- -300 + freeze_credit correction) -- must net to the corrected amount, not 300 nor 0.
  select expected_ils into v_exp from public._period_merged_athlete_finance(v_start, v_start) where kind='app' and pid=v_p::text;

  declare v_total_days int; v_correction numeric;
  begin
    v_total_days := v_end - v_start;
    v_correction := round(300::numeric * (v_total_days - 5) / v_total_days, 2);
    if v_exp <> v_correction then
      raise exception 'B14 FAILED: expected net % (300 - 300 + %), got %', v_correction, v_correction, v_exp;
    end if;
  end;

  raise notice 'B14 PASSED: reversal (-300) + original (300) + freeze_credit correction nets correctly to %', v_exp;
end $$;

-- Test B15: family roll-up still correct with a subscription charge present for one member.
do $$
declare
  v_p uuid; v_fam_id uuid; v_start date; v_sub uuid;
  v_fam_expected numeric;
begin
  select v into v_p from _billing_ids4 where k='b13_p';
  select v into v_sub from _billing_ids4 where k='b13_sub';
  select period_start into v_start from subscription_billing_periods where subscription_id=v_sub limit 1;

  insert into public.athlete_families (name) values ('B15 Test Family') returning id into v_fam_id;
  insert into public.athlete_family_members (family_id, user_id) values (v_fam_id, v_p);

  select (g->>'expected_ils')::numeric into v_fam_expected
  from json_array_elements(public._manager_weekly_stats_families_json(v_start, v_start)) g
  where g->>'id' = v_fam_id::text;

  if v_fam_expected is null then
    raise exception 'B15 FAILED: family not found in rollup output';
  end if;
  -- Should equal the same member-level expected_ils computed in B14 (post-correction).
  if v_fam_expected <> (select expected_ils from public._period_merged_athlete_finance(v_start, v_start) where kind='app' and pid=v_p::text) then
    raise exception 'B15 FAILED: family rollup (%) does not match member finance', v_fam_expected;
  end if;
  raise notice 'B15 PASSED: family roll-up correctly includes the subscription-adjusted member total (%)', v_fam_expected;
end $$;

-- Test B16: non-subscription athlete's finance output is provably unchanged by Phase 3 code.
do $$
declare
  v_p uuid; v_coach uuid; v_sess uuid; v_exp numeric;
begin
  v_p := gen_random_uuid();
  v_coach := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_p, 'athlete_b16', 'Athlete B16', '0500001016', 'athlete', 'approved'),
    (v_coach, 'coach_b16', 'Coach B16', '0500001017', 'coach', 'approved');

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (current_date + 300, '09:00', v_coach, 4) returning id into v_sess;

  perform set_config('app.current_uid', v_p::text, true);
  perform public.register_for_session(v_sess);
  update session_registrations set attended = true where session_id=v_sess and user_id=v_p;

  -- Run the full billing job (system-wide) -- must have zero effect on a payee with no
  -- subscription rows at all.
  perform public.generate_due_subscription_charges();

  select expected_ils into v_exp from public._period_merged_athlete_finance(current_date + 300, current_date + 300)
  where kind='app' and pid=v_p::text;
  if v_exp <> 120 then raise exception 'B16 FAILED: expected unchanged 120 (stub price), got %', v_exp; end if;
  if exists (select 1 from subscription_registration_coverage cov join session_registrations r on r.id=cov.registration_id where r.session_id=v_sess) then
    raise exception 'B16 FAILED: a coverage row was created for a non-subscribed athlete';
  end if;
  raise notice 'B16 PASSED: non-subscriber finance output unchanged by Phase 3 billing job (expected_ils=%)', v_exp;
end $$;

do $$ begin raise notice 'ALL BILLING TESTS BATCH 4 (B13-B16) PASSED'; end $$;
