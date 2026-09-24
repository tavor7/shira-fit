set client_min_messages to notice;

-- Concurrency test: two simultaneous registration attempts for the last remaining weekly slot.
-- Uses two separate DB sessions (via dblink-free approach: two psql processes racing on the
-- same advisory lock key) to prove pg_advisory_xact_lock serializes them and exactly one wins.

drop table if exists _conc_ids;
create table _conc_ids (k text primary key, v uuid);

do $$
declare
  v_coach uuid; v_d uuid; v_sub uuid; v_ver uuid; v_sess uuid;
  v_day date;
begin
  v_day := (current_date + 30) - extract(dow from (current_date + 30))::int; -- Sunday
  select v into v_coach from _test_ids where k='coach';
  v_d := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_d, 'athlete_d', 'Athlete D', '0500000007', 'athlete', 'approved');

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_d, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_day - 10, 300, 1, v_day - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_day, '09:00', v_coach, 1) returning id into v_sess;

  insert into _conc_ids values ('d', v_d), ('sess', v_sess);

  declare v_sess2 uuid;
  begin
    insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
    values (v_day + 2, '09:00', v_coach, 1) returning id into v_sess2;
    insert into _conc_ids values ('sess2', v_sess2);
  end;
end $$;
