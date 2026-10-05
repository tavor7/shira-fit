-- Regression test for 20261005150000_subscription_billing_log_failures.sql.
--
-- A subscription whose billing period cannot be generated must (a) not abort the daily job for
-- other subscriptions, (b) be counted in subscriptions_failed, and (c) leave a
-- 'subscription_billing_failed' event naming the subscription. The failure is injected with a
-- trigger on subscription_billing_periods that raises for one subscription only (its id is passed
-- through a transaction-local setting). Self-contained; everything is rolled back.
set client_min_messages to notice;
begin;

create function public.t132_fail() returns trigger language plpgsql as $b$
begin
  if new.subscription_id::text = current_setting('t132.bad_sub', true) then
    raise exception 't132 injected failure';
  end if;
  return new;
end $b$;
create trigger t132_fail_trg before insert on public.subscription_billing_periods
  for each row execute function public.t132_fail();

do $$
declare
  v_ath_bad uuid := gen_random_uuid();
  v_ath_ok uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_bad_sub uuid;
  v_ok_sub uuid;
  v_res json;
  v_logged int;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email,
         jsonb_build_object('full_name', u.fn, 'phone', u.ph, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_ath_bad, 't132-bad@test.local', 'T132 Bad', '0501320001'),
               (v_ath_ok,  't132-ok@test.local',  'T132 Ok',  '0501320002'),
               (v_mgr,     't132-mgr@test.local', 'T132 Mgr', '0501320003')) as u(id, email, fn, ph);
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.profiles set approval_status = 'approved' where user_id in (v_ath_bad, v_ath_ok);

  -- Create both subscriptions with a future start (nothing due yet), then make them due.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.create_subscription(v_ath_bad, false, 100, current_date + 30, null, 1::smallint, '[]'::jsonb);
  v_bad_sub := (v_res->>'subscription_id')::uuid;
  v_res := public.create_subscription(v_ath_ok, false, 100, current_date + 30, null, 1::smallint, '[]'::jsonb);
  v_ok_sub := (v_res->>'subscription_id')::uuid;
  if v_bad_sub is null or v_ok_sub is null then
    raise exception 'T0 FAILED: could not create fixtures: %', v_res;
  end if;
  perform set_config('request.jwt.claims', '', true);

  update public.subscription_versions set plan_start_date = current_date - 1
  where subscription_id in (v_bad_sub, v_ok_sub) and effective_to is null;
  perform set_config('t132.bad_sub', v_bad_sub::text, true);

  v_res := public.generate_due_subscription_charges();

  -- T1: the job completes and reports the failure.
  if (v_res->>'subscriptions_failed')::int < 1 then
    raise exception 'T1 FAILED: subscriptions_failed not counted: %', v_res;
  end if;
  raise notice 'T1 PASSED: job completed and counted the failed subscription (%)', v_res;

  -- T2: the healthy subscription was still billed despite the other one failing.
  if not exists (select 1 from public.subscription_billing_periods where subscription_id = v_ok_sub) then
    raise exception 'T2 FAILED: healthy subscription was not billed';
  end if;
  if exists (select 1 from public.subscription_billing_periods where subscription_id = v_bad_sub) then
    raise exception 'T2 FAILED: the injected failure did not take effect';
  end if;
  raise notice 'T2 PASSED: healthy subscription billed, failing one isolated';

  -- T3: the failure is recorded against the right subscription, with the error text.
  select count(*) into v_logged from public.user_activity_events
  where event_type = 'subscription_billing_failed' and target_id = v_bad_sub::text
    and metadata->>'error' like '%injected failure%';
  if v_logged <> 1 then
    raise exception 'T3 FAILED: expected 1 failure event for the bad subscription, found %', v_logged;
  end if;
  if exists (select 1 from public.user_activity_events
             where event_type = 'subscription_billing_failed' and target_id = v_ok_sub::text) then
    raise exception 'T3 FAILED: a failure event was logged for the healthy subscription';
  end if;
  raise notice 'T3 PASSED: failure logged for the failing subscription only';

  raise notice 'ALL SUBSCRIPTION BILLING FAILURE-LOGGING TESTS (T1-T3) PASSED';
end $$;

rollback;
