set client_min_messages to notice;

-- Concurrency setup: athlete J has personal-tier weekly_limit=1, currently used by a covered
-- registration at session P, then cancelled without charge (releasing the slot). Two concurrent
-- operations race for that SAME now-free slot:
--   (A) a manager undoes the cancellation (restoring P to active) via manager_revert_activity_event
--   (B) J independently registers fresh for session Q (same tier/week)
-- Both route through subscription_reserve_or_reject with the same subscription_lock_key for
-- (payee=J, week, tier='personal') -- exactly one should end up covered=true.
drop table if exists _revert_conc_ids;
create table _revert_conc_ids (k text primary key, v uuid);

do $$
declare
  v_coach uuid; v_manager uuid; v_j uuid; v_sub uuid; v_ver uuid;
  v_week_sun date; v_p uuid; v_q uuid; v_reg_p uuid; v_ev_id uuid; v_res json;
begin
  select v into v_coach from _move_ids where k='coach';
  select v into v_manager from _move_ids where k='manager';

  v_j := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_j, 'athlete_j', 'Athlete J', '0500000601', 'athlete', 'approved');

  v_week_sun := (current_date + 200) - extract(dow from (current_date + 200))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_j, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'personal', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 1) returning id into v_p;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 1) returning id into v_q;

  perform set_config('app.current_uid', v_j::text, true);
  v_res := public.register_for_session(v_p);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'revert concurrency setup FAILED: %', v_res;
  end if;
  select id into v_reg_p from session_registrations where session_id=v_p and user_id=v_j;

  update session_registrations set status='cancelled' where id=v_reg_p; -- releases the slot

  insert into user_activity_events (actor_user_id, event_type, target_type, target_id, metadata)
  values (v_manager, 'session_registration_status_changed', 'session_registration', v_reg_p::text,
    jsonb_build_object('session_id', v_p, 'user_id', v_j, 'from', 'active', 'to', 'cancelled'))
  returning id into v_ev_id;

  insert into _revert_conc_ids values
    ('manager', v_manager), ('j', v_j), ('p', v_p), ('q', v_q), ('ev', v_ev_id);
end $$;
