-- Regression tests for 20261020140000_system_monitoring_critical_push.sql.
-- Self-contained; rolled back at the end. Does not require vault secrets or a real HTTP round
-- trip for most assertions; the processor's graceful no-op without secrets is itself asserted (P5).
set client_min_messages to notice;
begin;

update public.system_monitoring_config set value = 'true'::jsonb where key = 'critical_push_enabled';

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_count int;
begin
  insert into auth.users (id, email) values (v_mgr, 'push_mgr_184@test.local');
  update public.profiles set role = 'manager', disabled_at = null, approval_status = 'approved'
  where user_id = v_mgr;

  -- P1: a critical issue enqueues exactly one outbox row per active manager.
  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_op',
    p_message := 'first critical', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184');

  select count(*) into v_count from public.system_issue_push_outbox where manager_id = v_mgr;
  if v_count <> 1 then
    raise exception 'P1 FAILED: expected exactly 1 outbox row after first critical occurrence, found %', v_count;
  end if;
  raise notice 'P1 PASSED: a new critical issue enqueues one outbox row per active manager';

  -- P2: a repeated occurrence of the SAME unresolved critical issue does not enqueue again.
  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_op',
    p_message := 'repeat', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184');

  select count(*) into v_count from public.system_issue_push_outbox where manager_id = v_mgr;
  if v_count <> 1 then
    raise exception 'P2 FAILED: a repeated occurrence must not add a second outbox row, found %', v_count;
  end if;
  raise notice 'P2 PASSED: a repeated occurrence of an unresolved critical issue does not re-enqueue';

  -- P3: high/medium/low severity never reach the outbox at all.
  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_op_warn',
    p_message := 'not critical', p_severity := 'warning',
    p_fingerprint_key := 'push_test_issue_184_warning');

  if exists (
    select 1 from public.system_issue_push_outbox o
    join public.system_issues i on i.id = o.issue_id
    where i.fingerprint = md5('key' || chr(31) || 'push_test_issue_184_warning')
  ) then
    raise exception 'P3 FAILED: a warning-severity issue must never reach the push outbox';
  end if;
  raise notice 'P3 PASSED: non-critical severities never reach the outbox';
end $$;

-- P4: resolve then reopen-as-critical allows exactly one new notification (new lifecycle_epoch).
do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_issue_id uuid;
  v_before int;
  v_after int;
begin
  insert into auth.users (id, email) values (v_mgr, 'push_mgr_184b@test.local');
  update public.profiles set role = 'manager', disabled_at = null, approval_status = 'approved'
  where user_id = v_mgr;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_reopen',
    p_message := 'first', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184_reopen');

  select id into v_issue_id from public.system_issues
  where fingerprint = md5('key' || chr(31) || 'push_test_issue_184_reopen');

  select count(*) into v_before from public.system_issue_push_outbox
  where issue_id = v_issue_id and manager_id = v_mgr;

  update public.system_issues set status = 'resolved', resolved_at = now(), resolution = 'manual_fixed'
  where id = v_issue_id;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_reopen',
    p_message := 'recurs after resolution', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184_reopen');

  select count(*) into v_after from public.system_issue_push_outbox
  where issue_id = v_issue_id and manager_id = v_mgr;

  if v_before <> 1 or v_after <> 2 then
    raise exception 'P4 FAILED: expected 1 outbox row before reopen and 2 after (new epoch), got % and %', v_before, v_after;
  end if;
  raise notice 'P4 PASSED: reopening a resolved issue as critical allows exactly one new notification';
end $$;

-- P5: the processor no-ops safely without vault secrets configured (no crash, no false "sent").
do $$
declare
  v_res jsonb;
begin
  v_res := public._system_push_outbox_process();
  if (v_res->>'enabled')::boolean is distinct from true or (v_res->>'error') is distinct from 'missing_vault_secrets' then
    raise exception 'P5 FAILED: expected enabled:true, error:missing_vault_secrets, got %', v_res;
  end if;
  if exists (select 1 from public.system_issue_push_outbox where status = 'sent') then
    raise exception 'P5 FAILED: nothing may be marked sent without a real dispatch';
  end if;
  raise notice 'P5 PASSED: the processor no-ops safely when vault secrets are not configured';
end $$;

-- P6: internal push functions are not executable by any client role; the outbox table is
-- manager-read-only with no client write access.
do $$
begin
  if has_function_privilege('authenticated', 'public._system_push_outbox_process(integer)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._system_push_outbox_process(integer)'::regprocedure, 'EXECUTE') then
    raise exception 'P6 FAILED: _system_push_outbox_process must not be client-executable';
  end if;
  if has_table_privilege('authenticated', 'public.system_issue_push_outbox', 'INSERT')
     or has_table_privilege('authenticated', 'public.system_issue_push_outbox', 'UPDATE')
     or has_table_privilege('authenticated', 'public.system_issue_push_outbox', 'DELETE') then
    raise exception 'P6 FAILED: authenticated must not be able to write system_issue_push_outbox';
  end if;
  raise notice 'P6 PASSED: internal push functions and the outbox table are properly locked down';
end $$;

-- P7: critical_push_enabled=false makes the enqueue trigger a no-op even for a critical issue.
do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_count int;
begin
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'critical_push_enabled';
  insert into auth.users (id, email) values (v_mgr, 'push_mgr_184c@test.local');
  update public.profiles set role = 'manager', disabled_at = null, approval_status = 'approved'
  where user_id = v_mgr;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_disabled',
    p_message := 'disabled', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184_disabled');

  select count(*) into v_count from public.system_issue_push_outbox where manager_id = v_mgr;
  if v_count <> 0 then
    raise exception 'P7 FAILED: expected no outbox row while critical_push_enabled=false, found %', v_count;
  end if;
  raise notice 'P7 PASSED: the enqueue trigger is fully inert while critical_push_enabled=false';
end $$;

-- P8: escalation to critical via a rule's severity_floor (not just direct critical creation)
-- enqueues correctly - the trigger is generic over HOW a row became open+critical.
do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_issue_id uuid;
  v_sev text;
  v_count int;
begin
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'critical_push_enabled';
  insert into auth.users (id, email) values (v_mgr, 'push_mgr_184_p8@test.local');
  update public.profiles set role = 'manager', disabled_at = null, approval_status = 'approved'
  where user_id = v_mgr;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_escalate',
    p_message := 'starts as error', p_severity := 'error',
    p_fingerprint_key := 'push_test_issue_184_escalate');

  select id, severity into v_issue_id, v_sev from public.system_issues
  where fingerprint = md5('key' || chr(31) || 'push_test_issue_184_escalate');
  if v_sev <> 'error' then
    raise exception 'P8 FAILED: expected the issue to start at error severity, got %', v_sev;
  end if;
  if exists (select 1 from public.system_issue_push_outbox where issue_id = v_issue_id and manager_id = v_mgr) then
    raise exception 'P8 FAILED: an error-severity issue must not enqueue a push';
  end if;

  insert into public.system_issue_rules (match_operation, severity_floor)
  values ('push_test_escalate', 'critical');

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_escalate',
    p_message := 'recurs after the rule is added', p_severity := 'error',
    p_fingerprint_key := 'push_test_issue_184_escalate');

  select severity into v_sev from public.system_issues where id = v_issue_id;
  if v_sev <> 'critical' then
    raise exception 'P8 FAILED: expected the rule to escalate the issue to critical, got %', v_sev;
  end if;

  select count(*) into v_count from public.system_issue_push_outbox
  where issue_id = v_issue_id and manager_id = v_mgr;
  if v_count <> 1 then
    raise exception 'P8 FAILED: expected exactly one outbox row after rule-driven escalation to critical, found %', v_count;
  end if;
  raise notice 'P8 PASSED: escalation to critical via a rule severity_floor enqueues exactly one push';
end $$;

-- P9: a failure inside the enqueue trigger (simulated by making the manager lookup itself fail)
-- must never block the system_issues write that triggered it.
do $$
declare
  v_count_before int;
  v_count_after int;
begin
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'critical_push_enabled';
  select count(*) into v_count_before from public.system_issues;

  -- Temporarily break the enqueue trigger's own dependency (restored by this transaction's rollback)
  -- to force a genuine exception inside _system_issues_critical_push_enqueue, not a business outcome.
  alter table public.profiles rename column disabled_at to disabled_at_tmp_p9;

  perform public._report_system_error(
    p_source := 'trusted', p_subsystem := 'test', p_operation := 'push_test_trigger_failure',
    p_message := 'enqueue trigger dependency is broken', p_severity := 'critical',
    p_fingerprint_key := 'push_test_issue_184_trigger_failure');

  alter table public.profiles rename column disabled_at_tmp_p9 to disabled_at;

  select count(*) into v_count_after from public.system_issues;
  if v_count_after <> v_count_before + 1 then
    raise exception 'P9 FAILED: the system_issues write must still succeed even if the enqueue trigger fails internally';
  end if;
  if not exists (select 1 from public.system_issues where fingerprint = md5('key' || chr(31) || 'push_test_issue_184_trigger_failure')) then
    raise exception 'P9 FAILED: the critical issue itself must have been created';
  end if;
  raise notice 'P9 PASSED: an internal enqueue-trigger failure never blocks the system_issues write';
end $$;

rollback;
