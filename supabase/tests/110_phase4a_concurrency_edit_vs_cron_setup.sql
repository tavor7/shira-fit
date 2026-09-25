-- Phase 4A real two-process concurrency test, race 1: edit_subscription_version vs.
-- generate_due_subscription_charges (the daily cron), racing on the SAME subscription.
--
-- Run (against the scratch postgres:15 container, after 00-03 stubs + all Phase 1-4A migrations
-- + 100/101 test files): load this setup file first (one psql process), then launch
-- 111_..._race_a.sql (the edit) and 112_..._race_b.sql (the cron) as two SEPARATE, CONCURRENT psql
-- processes (each opens its own connection/transaction), then run
-- 113_..._verify.sql afterward.
set client_min_messages to notice;

do $$
declare
  v_manager uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sub uuid;
  v_start date := current_date - 40; -- old enough that a second period is also naturally due
begin
  create table if not exists _p4a_race_ids (k text primary key, v uuid);
  delete from _p4a_race_ids;

  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values
    (v_manager, 'p4a_race_mgr', 'P4A Race Manager', '9101', 'manager', 'approved'),
    (v_athlete, 'p4a_race_ath1', 'P4A Race Athlete 1', '9102', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  perform public.create_subscription(
    v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb
  );

  select id into v_sub from subscriptions where payee_id = v_athlete and payee_is_manual = false;

  insert into _p4a_race_ids values ('manager', v_manager), ('athlete1', v_athlete), ('sub1', v_sub);

  raise notice 'RACE1 SETUP OK: subscription % (start %, price 300)', v_sub, v_start;
end $$;
