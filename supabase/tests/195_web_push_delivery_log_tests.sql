-- web_push_delivery_log: manager-only SELECT (service-role Edge Function writes bypass RLS;
-- no client-write policy exists at all). Real-role test (not just SECURITY DEFINER logic) --
-- role switching follows the same pattern as 138_system_monitoring_security_tests.sql.
set client_min_messages to notice;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_ath uuid := gen_random_uuid();
  v_log_id uuid := gen_random_uuid();
  v_count int;
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_mgr, 'wpdl_mgr', 'WPDL Manager', '9501', 'manager', 'approved'),
    (v_coach, 'wpdl_coach', 'WPDL Coach', '9502', 'coach', 'approved'),
    (v_ath, 'wpdl_ath', 'WPDL Athlete', '9503', 'athlete', 'approved');

  insert into public.web_push_delivery_log (id, user_id, notification_kind, outcome, http_status, error_detail)
  values (v_log_id, v_ath, 'manager_operational', 'failed', 401, 'test fixture row');

  -- === A: manager can select ===
  execute 'reset role';
  perform set_config('app.current_uid', v_mgr::text, true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.web_push_delivery_log where id = v_log_id;
  execute 'reset role';
  if v_count <> 1 then
    raise exception 'A FAILED: manager should see the delivery-log row, got count=%', v_count;
  end if;
  raise notice 'A PASSED: manager can select web_push_delivery_log';

  -- === B: coach cannot select ===
  execute 'reset role';
  perform set_config('app.current_uid', v_coach::text, true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.web_push_delivery_log where id = v_log_id;
  execute 'reset role';
  if v_count <> 0 then
    raise exception 'B FAILED: coach should not see any delivery-log rows, got count=%', v_count;
  end if;
  raise notice 'B PASSED: coach cannot select web_push_delivery_log';

  -- === C: athlete (even the row's own subject) cannot select ===
  execute 'reset role';
  perform set_config('app.current_uid', v_ath::text, true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.web_push_delivery_log where id = v_log_id;
  execute 'reset role';
  if v_count <> 0 then
    raise exception 'C FAILED: athlete should not see any delivery-log rows, got count=%', v_count;
  end if;
  raise notice 'C PASSED: athlete cannot select web_push_delivery_log';
end $$;
