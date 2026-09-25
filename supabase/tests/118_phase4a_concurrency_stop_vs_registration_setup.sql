-- Phase 4A real two-process concurrency test, race 3: stop_subscription vs. register_for_session,
-- racing on a session date right at the stop's effective boundary.
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sub uuid;
  v_sess uuid;
  v_sun date := current_date - extract(dow from current_date)::int + 21; -- 3 weeks out
  v_stop_date date;
begin
  create table if not exists _p4a_race_ids (k text primary key, v uuid);
  delete from _p4a_race_ids where k like 'r3_%';
  create table if not exists _p4a_race_dates (k text primary key, v date);
  delete from _p4a_race_dates where k = 'r3_stop_date';

  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'p4a_race3_mgr', 'P4A Race3 Manager', '9301', 'manager', 'approved'),
    (v_coach, 'p4a_race3_coach', 'P4A Race3 Coach', '9302', 'coach', 'approved'),
    (v_athlete, 'p4a_race3_ath', 'P4A Race3 Athlete', '9303', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  perform public.create_subscription(
    v_athlete, false, 300, current_date - 5, null, null,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 1))
  );
  select id into v_sub from subscriptions where payee_id = v_athlete and payee_is_manual = false;

  v_stop_date := v_sun + 1; -- the contested session date: stop takes effect exactly here
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_stop_date, '10:00', v_coach, 2) returning id into v_sess;

  insert into _p4a_race_ids values
    ('r3_manager', v_manager), ('r3_athlete', v_athlete), ('r3_sub', v_sub), ('r3_sess', v_sess);
  insert into _p4a_race_dates values ('r3_stop_date', v_stop_date);

  raise notice 'RACE3 SETUP OK: subscription %, session % on % (stop boundary), weekly_limit=1', v_sub, v_sess, v_stop_date;
end $$;
