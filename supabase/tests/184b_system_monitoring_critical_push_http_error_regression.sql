-- Regression test for a real bug caught during final release review: the collection pass in
-- _system_push_outbox_process (20261020140000) referenced an undeclared variable
-- (resp.status_code instead of v_status_code) on its non-200/202 branch. Every real HTTP error
-- response from send-web-push (not just a connection failure - any 4xx/5xx) would have raised
-- "column resp does not exist", caught only by the function's own outer exception handler, leaving
-- the affected row stuck in 'processing' and aborting the rest of that cycle's collection pass.
--
-- Run as its own file (not appended to 184's single transaction): combining vault.create_secret
-- with an intervening SAVEPOINT ROLLBACK in the same session produced an unrelated pgsodium/vault
-- error (sqlstate 42P01) in local testing. Isolating this file sidesteps that local harness
-- quirk entirely; the scenario itself needs no fixtures from 184.
set client_min_messages to notice;
begin;

update public.system_monitoring_config set value = 'true'::jsonb where key = 'critical_push_enabled';
select vault.create_secret('http://127.0.0.1:1/unused', 'send_web_push_url');
select vault.create_secret('unused-secret-value', 'send_web_push_secret');

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_outbox_id bigint;
  v_fake_request_id bigint := floor(random() * 1000000000)::bigint;
  v_status text;
  v_last_error text;
begin
  insert into auth.users (id, email) values (v_mgr, 'push_mgr_184b@test.local');
  update public.profiles set role = 'manager', disabled_at = null, approval_status = 'approved'
  where user_id = v_mgr;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_http_error',
    p_message := 'critical for http-error regression test', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184b_http_error');

  select id into v_outbox_id from public.system_issue_push_outbox where manager_id = v_mgr;

  -- Simulate "already dispatched, pg_net got a real response" without a real HTTP round trip.
  update public.system_issue_push_outbox
  set status = 'processing', locked_at = now(), net_request_id = v_fake_request_id
  where id = v_outbox_id;
  insert into net._http_response (id, status_code, created) values (v_fake_request_id, 500, now());

  perform public._system_push_outbox_process();

  select status, last_error into v_status, v_last_error
  from public.system_issue_push_outbox where id = v_outbox_id;

  if v_status <> 'pending' then
    raise exception 'FAILED: expected a 500 response to requeue the row as pending (with attempts left), got %', v_status;
  end if;
  if v_last_error is distinct from 'http_status_500' then
    raise exception 'FAILED: expected last_error=http_status_500, got %', v_last_error;
  end if;
  raise notice 'PASSED: a non-200/202 HTTP response is handled without crashing (regression for the resp/v_status_code bug)';
end $$;

rollback;
