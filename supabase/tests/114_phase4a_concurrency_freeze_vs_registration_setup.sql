-- Phase 4A real two-process concurrency test, race 2: freeze_subscription vs. register_for_session,
-- racing on the SAME session date for the SAME subscription/payee.
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sub uuid;
  v_sess uuid;
  v_sun date := current_date - extract(dow from current_date)::int + 14; -- 2 weeks out, safely future
  v_freeze_date date;
begin
  create table if not exists _p4a_race_ids (k text primary key, v uuid);
  delete from _p4a_race_ids where k like 'r2_%';

  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'p4a_race2_mgr', 'P4A Race2 Manager', '9201', 'manager', 'approved'),
    (v_coach, 'p4a_race2_coach', 'P4A Race2 Coach', '9202', 'coach', 'approved'),
    (v_athlete, 'p4a_race2_ath', 'P4A Race2 Athlete', '9203', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  perform public.create_subscription(
    v_athlete, false, 300, current_date - 5, null, null,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 1))
  );
  select id into v_sub from subscriptions where payee_id = v_athlete and payee_is_manual = false;

  v_freeze_date := v_sun + 1; -- Monday of that future week -- the exact contested date
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_freeze_date, '10:00', v_coach, 2) returning id into v_sess;

  insert into _p4a_race_ids values
    ('r2_manager', v_manager), ('r2_athlete', v_athlete), ('r2_sub', v_sub), ('r2_sess', v_sess);
  -- Also stash the date via a side table since _p4a_race_ids is uuid-only.
  create table if not exists _p4a_race_dates (k text primary key, v date);
  delete from _p4a_race_dates where k = 'r2_freeze_date';
  insert into _p4a_race_dates values ('r2_freeze_date', v_freeze_date);

  raise notice 'RACE2 SETUP OK: subscription %, session % on %, weekly_limit=1', v_sub, v_sess, v_freeze_date;
end $$;
