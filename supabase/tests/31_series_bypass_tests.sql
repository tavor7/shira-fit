-- Series roster-auto-copy tests for the fixed _copy_session_roster / _series_add_manual_participant_checked.
set client_min_messages to notice;

-- Test S1: series auto-copy with available allowance -> copied and covered.
do $$
declare
  v_coach uuid; v_mp uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_from_sess uuid; v_to_sess uuid;
begin
  select v into v_coach from _move_ids where k='coach';
  v_mp := gen_random_uuid();
  insert into public.manual_participants (id, full_name, phone) values (v_mp, 'Series MP One', '0500000101');

  v_week_sun := (current_date + 70) - extract(dow from (current_date + 70))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_mp, true) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 3);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 3) returning id into v_from_sess;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 3) returning id into v_to_sess;

  insert into public.session_manual_participants (session_id, manual_participant_id) values (v_from_sess, v_mp);

  perform public._copy_session_roster(v_from_sess, v_to_sess);

  if not exists (select 1 from session_manual_participants where session_id=v_to_sess and manual_participant_id=v_mp) then
    raise exception 'S1 FAILED: manual participant was not copied to the new occurrence';
  end if;
  if (select cov.covered from subscription_registration_coverage cov
        join session_manual_participants m on m.id=cov.manual_participant_id
       where m.session_id=v_to_sess and m.manual_participant_id=v_mp) is not true then
    raise exception 'S1 FAILED: copied manual participant should be covered=true';
  end if;
  raise notice 'S1 PASSED: series auto-copy with available allowance copied and covered';

  create table if not exists _series_ids (k text primary key, v uuid);
  insert into _series_ids values ('mp1', v_mp), ('sub1', v_sub) on conflict do nothing;
end $$;

-- Test S2: series auto-copy when allowance is exhausted -> skip + flag, no paid registration.
do $$
declare
  v_coach uuid; v_mp uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_occ1 uuid; v_occ2 uuid; v_occ3 uuid;
  v_log_count_before int; v_log_count_after int;
begin
  select v into v_coach from _move_ids where k='coach';
  v_mp := gen_random_uuid();
  insert into public.manual_participants (id, full_name, phone) values (v_mp, 'Series MP Two', '0500000102');

  v_week_sun := (current_date + 80) - extract(dow from (current_date + 80))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_mp, true) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 3) returning id into v_occ1;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 3) returning id into v_occ2;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 3, '09:00', v_coach, 3) returning id into v_occ3;

  -- Simulate the roster-copy sequence occurrence-by-occurrence (as _generate_series_occurrences
  -- does for 'copy_on_generate'): occ1 gets a direct add, occ2 copied from occ1 (covered, fills
  -- the 1-slot allowance), occ3 copied from occ2 (allowance exhausted -> must skip + flag).
  insert into public.session_manual_participants (session_id, manual_participant_id) values (v_occ1, v_mp);
  -- occ1's own coverage decision (simulating an initial manual add via the checked helper):
  perform public._series_add_manual_participant_checked(v_occ2, v_mp);
  if not exists (select 1 from session_manual_participants where session_id=v_occ2 and manual_participant_id=v_mp) then
    raise exception 'S2 setup FAILED: occ2 should have been added (covered, allowance available)';
  end if;

  v_log_count_before := (select count(*) from user_activity_events where event_type='series_manual_participant_subscription_skipped' and target_id=v_mp::text);

  perform public._series_add_manual_participant_checked(v_occ3, v_mp);

  if exists (select 1 from session_manual_participants where session_id=v_occ3 and manual_participant_id=v_mp) then
    raise exception 'S2 FAILED: occ3 should NOT have been added (allowance exhausted, no consent possible)';
  end if;

  v_log_count_after := (select count(*) from user_activity_events where event_type='series_manual_participant_subscription_skipped' and target_id=v_mp::text);
  if v_log_count_after <= v_log_count_before then
    raise exception 'S2 FAILED: skip was not logged via the activity-log convention';
  end if;
  raise notice 'S2 PASSED: allowance-exhausted series copy skipped, no paid registration created, logged to activity log';
end $$;

-- Test S3: series auto-copy during a freeze -> same safe (skip + flag) behavior.
do $$
declare
  v_coach uuid; v_mp uuid; v_sub uuid; v_ver uuid; v_week_sun date;
  v_occ1 uuid; v_occ_frozen uuid;
  v_log_count_before int; v_log_count_after int;
begin
  select v into v_coach from _move_ids where k='coach';
  v_mp := gen_random_uuid();
  insert into public.manual_participants (id, full_name, phone) values (v_mp, 'Series MP Three', '0500000103');

  v_week_sun := (current_date + 90) - extract(dow from (current_date + 90))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_mp, true) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'trio', 3);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 3) returning id into v_occ1;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 3) returning id into v_occ_frozen;

  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
  values (v_sub, v_week_sun + 2, v_week_sun + 2);

  insert into public.session_manual_participants (session_id, manual_participant_id) values (v_occ1, v_mp);

  v_log_count_before := (select count(*) from user_activity_events where event_type='series_manual_participant_subscription_skipped' and target_id=v_mp::text);

  perform public._copy_session_roster(v_occ1, v_occ_frozen);

  if exists (select 1 from session_manual_participants where session_id=v_occ_frozen and manual_participant_id=v_mp) then
    raise exception 'S3 FAILED: frozen occurrence should NOT have received the copied participant';
  end if;

  v_log_count_after := (select count(*) from user_activity_events where event_type='series_manual_participant_subscription_skipped' and target_id=v_mp::text);
  if v_log_count_after <= v_log_count_before then
    raise exception 'S3 FAILED: frozen skip was not logged';
  end if;
  raise notice 'S3 PASSED: series auto-copy during a freeze skipped safely, no paid registration, logged';
end $$;

do $$ begin raise notice 'ALL SERIES TESTS PASSED'; end $$;
