-- System monitoring Phase 1: REAL-ROLE security tests (anon / authenticated with JWT claims).
--
-- Roles exercised: anon; athlete; coach; active manager (is_super_user = false); active manager
-- (is_super_user = true); disabled manager; service_role. Covers reads (RLS), direct writes, config /
-- rules / quota access, lifecycle RPC authorization, internal-function access, and the full client
-- ingestion forgery matrix (user id, source, critical, impact, lifecycle, rule, fingerprint, context,
-- secrets, new-fingerprint flooding, quota, injection strings).
--
-- Self-contained: own auth.users fixtures; everything is rolled back at the end.
set client_min_messages to notice;
begin;

create temp table t138_fx (k text primary key, v uuid);
grant all on t138_fx to public;

-- Run p_sql as p_role (with JWT sub p_uid). Returns true iff it was rejected with insufficient_privilege.
create function pg_temp.t138_denied(p_role text, p_uid uuid, p_sql text) returns boolean language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute 'set local role ' || quote_ident(p_role);
  begin
    execute p_sql;
  exception when insufficient_privilege then
    execute 'reset role';
    return true;
  end;
  execute 'reset role';
  return false;
end $f$;

-- Run a scalar-bigint query as p_role.
create function pg_temp.t138_scalar(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute 'set local role ' || quote_ident(p_role);
  execute p_sql into v;
  execute 'reset role';
  return v;
end $f$;

-- Run a function returning json as p_role.
create function pg_temp.t138_json(p_role text, p_uid uuid, p_sql text) returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute 'set local role ' || quote_ident(p_role);
  execute p_sql into v;
  execute 'reset role';
  return v;
end $f$;

create function pg_temp.t138_uid(p_k text) returns uuid language sql as $$ select v from t138_fx where k = p_k $$;

do $$
declare
  v_ath uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_mgr_super uuid := gen_random_uuid();
  v_mgr_dis uuid := gen_random_uuid();
  v_issue uuid;
  v_col text;
  v_tbl text;
  v_n bigint;
  v_res jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_ath,       't138-ath@test.local',    '0501380001'),
               (v_coach,     't138-coach@test.local',  '0501380002'),
               (v_mgr,       't138-mgr@test.local',    '0501380003'),
               (v_mgr_super, 't138-super@test.local',  '0501380004'),
               (v_mgr_dis,   't138-dis@test.local',    '0501380005')) u(id, e, p);
  update public.profiles set approval_status = 'approved' where user_id in (v_ath, v_coach, v_mgr, v_mgr_super, v_mgr_dis);
  update public.profiles set role = 'coach' where user_id = v_coach;
  update public.profiles set role = 'manager' where user_id in (v_mgr, v_mgr_super, v_mgr_dis);
  update public.profiles set is_super_user = true where user_id = v_mgr_super;
  update public.profiles set disabled_at = now() where user_id = v_mgr_dis;
  insert into t138_fx values ('ath', v_ath), ('coach', v_coach), ('mgr', v_mgr), ('super', v_mgr_super), ('dis', v_mgr_dis);

  -- Seed data through the trusted internal path (as the migration owner).
  perform public._system_ingest('trusted', jsonb_build_object('source', 'db', 'subsystem', 'billing', 'operation', 'fn/seed',
    'error_code', '23505', 'message', 'seed failure', 'severity', 'error'), null);
  select id into v_issue from public.system_issues where operation = 'fn/seed';
  insert into t138_fx values ('issue', v_issue);

  -- ===== S1: anon has no access at all =====
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions',
                               'system_issue_rules', 'system_monitoring_config', 'system_report_quota'] loop
    if not pg_temp.t138_denied('anon', null, 'select count(*) from public.' || v_tbl) then
      raise exception 'S1 FAILED: anon could read public.%', v_tbl;
    end if;
  end loop;
  foreach v_tbl in array array['public.report_client_error(''{}''::jsonb)', 'public.system_report_trusted(''{}''::jsonb)',
      'public.system_monitoring_is_manager()', 'public.system_issue_acknowledge(gen_random_uuid())',
      'public._system_ingest(''trusted'', ''{}''::jsonb, null)', 'public._report_system_error(''db'', ''x'', ''fn/x'')'] loop
    if not pg_temp.t138_denied('anon', null, 'select ' || v_tbl) then
      raise exception 'S1 FAILED: anon could execute %', v_tbl;
    end if;
  end loop;
  raise notice 'S1 PASSED: anon cannot read any monitoring table or execute any monitoring function';

  -- ===== S2: athlete / coach read nothing (RLS) =====
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'] loop
    if pg_temp.t138_scalar('authenticated', v_ath, 'select count(*) from public.' || v_tbl) <> 0 then
      raise exception 'S2 FAILED: athlete read rows from public.%', v_tbl;
    end if;
    if pg_temp.t138_scalar('authenticated', v_coach, 'select count(*) from public.' || v_tbl) <> 0 then
      raise exception 'S2 FAILED: coach read rows from public.%', v_tbl;
    end if;
  end loop;
  raise notice 'S2 PASSED: athletes and coaches see zero monitoring rows in all four data tables';

  -- ===== S3: active managers (super or not) read everything; disabled manager reads nothing =====
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'] loop
    if pg_temp.t138_scalar('authenticated', v_mgr, 'select count(*) from public.' || v_tbl) < 1 then
      raise exception 'S3 FAILED: active manager (non-super) cannot read public.%', v_tbl;
    end if;
    if pg_temp.t138_scalar('authenticated', v_mgr_super, 'select count(*) from public.' || v_tbl)
       <> pg_temp.t138_scalar('authenticated', v_mgr, 'select count(*) from public.' || v_tbl) then
      raise exception 'S3 FAILED: is_super_user changes what a manager can read in public.%', v_tbl;
    end if;
    if pg_temp.t138_scalar('authenticated', v_mgr_dis, 'select count(*) from public.' || v_tbl) <> 0 then
      raise exception 'S3 FAILED: DISABLED manager can read public.%', v_tbl;
    end if;
    -- select * (every column) must work for managers: the column grants cover the whole table.
    if pg_temp.t138_scalar('authenticated', v_mgr, 'select count(*) from (select * from public.' || v_tbl || ') x') < 1 then
      raise exception 'S3 FAILED: select * failed for manager on public.%', v_tbl;
    end if;
  end loop;
  if pg_temp.t138_json('authenticated', v_mgr, 'select to_jsonb(public.system_monitoring_is_manager())') <> 'true'::jsonb
     or pg_temp.t138_json('authenticated', v_mgr_super, 'select to_jsonb(public.system_monitoring_is_manager())') <> 'true'::jsonb
     or pg_temp.t138_json('authenticated', v_mgr_dis, 'select to_jsonb(public.system_monitoring_is_manager())') <> 'false'::jsonb
     or pg_temp.t138_json('authenticated', v_ath, 'select to_jsonb(public.system_monitoring_is_manager())') <> 'false'::jsonb
     or pg_temp.t138_json('authenticated', v_coach, 'select to_jsonb(public.system_monitoring_is_manager())') <> 'false'::jsonb then
    raise exception 'S3 FAILED: system_monitoring_is_manager() gives the wrong answer for a role';
  end if;
  raise notice 'S3 PASSED: all active managers read all four tables identically (super-user flag irrelevant); the disabled manager reads nothing';

  -- ===== S4: managers cannot directly write any monitoring table; cannot touch rules/config/quota =====
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'] loop
    if not pg_temp.t138_denied('authenticated', v_mgr, 'delete from public.' || v_tbl) then
      raise exception 'S4 FAILED: manager could DELETE from public.%', v_tbl;
    end if;
    if not pg_temp.t138_denied('authenticated', v_mgr, 'truncate public.' || v_tbl) then
      raise exception 'S4 FAILED: manager could TRUNCATE public.%', v_tbl;
    end if;
  end loop;
  if not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issues set status = ''resolved'', severity = ''info''')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issues set occurrence_count = 0')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issue_events set message = ''x''')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issue_buckets set count = 0')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issue_transitions set kind = ''ack''') then
    raise exception 'S4 FAILED: manager could UPDATE a monitoring row directly';
  end if;
  if not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_issues (fingerprint, source, operation, title, latest_summary, base_severity, severity) values (md5(''a''), ''x1'', ''op'', ''t'', ''s'', ''info'', ''info'')')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_issue_events (issue_id, severity, sample_reason) select id, ''info'', ''first'' from public.system_issues limit 1')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_issue_buckets (issue_id, bucket_start) select id, now() from public.system_issues limit 1')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_issue_transitions (issue_id, to_status, kind) select id, ''open'', ''create'' from public.system_issues limit 1') then
    raise exception 'S4 FAILED: manager could INSERT into a monitoring table directly';
  end if;
  -- every single column of every data table: no UPDATE and no INSERT for a manager (column by column,
  -- so a stray single-column grant cannot hide behind a multi-column statement)
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'] loop
    for v_col in select a.attname::text from pg_attribute a where a.attrelid = ('public.' || v_tbl)::regclass and a.attnum > 0 and not a.attisdropped loop
      if not pg_temp.t138_denied('authenticated', v_mgr, format('update public.%I set %I = default', v_tbl, v_col)) then
        raise exception 'S4 FAILED: manager can UPDATE column %.%', v_tbl, v_col;
      end if;
      if not pg_temp.t138_denied('authenticated', v_mgr, format('insert into public.%I (%I) values (default)', v_tbl, v_col)) then
        raise exception 'S4 FAILED: manager can INSERT column %.%', v_tbl, v_col;
      end if;
    end loop;
  end loop;
  foreach v_tbl in array array['system_issue_rules', 'system_monitoring_config', 'system_report_quota'] loop
    if not pg_temp.t138_denied('authenticated', v_mgr, 'select count(*) from public.' || v_tbl) then
      raise exception 'S4 FAILED: manager could READ public.%', v_tbl;
    end if;
    if not pg_temp.t138_denied('authenticated', v_mgr, 'delete from public.' || v_tbl) then
      raise exception 'S4 FAILED: manager could DELETE from public.%', v_tbl;
    end if;
  end loop;
  if not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_monitoring_config set value = ''false''::jsonb')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_monitoring_config (key, value) values (''x'', ''1''::jsonb)')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_issue_rules set enabled = false')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'insert into public.system_issue_rules (match_operation, action) values (''rpc/x'', ''ignore'')')
     or not pg_temp.t138_denied('authenticated', v_mgr, 'update public.system_report_quota set reports = 0') then
    raise exception 'S4 FAILED: manager could modify configuration / rules / quota';
  end if;
  -- the same for the authenticated athlete (any authenticated user)
  if not pg_temp.t138_denied('authenticated', v_ath, 'update public.system_monitoring_config set value = ''true''::jsonb where key = ''client_ingest_enabled''')
     or not pg_temp.t138_denied('authenticated', v_ath, 'insert into public.system_issue_rules (match_operation, action) values (''rpc/x'', ''ignore'')') then
    raise exception 'S4 FAILED: an ordinary authenticated user could modify configuration or rules';
  end if;
  raise notice 'S4 PASSED: managers (and others) cannot INSERT/UPDATE/DELETE/TRUNCATE monitoring rows, nor read or write rules, config or quota';

  -- ===== S5: internal / trusted functions are not callable by any client role =====
  foreach v_tbl in array array[
    'public._system_ingest(''trusted'', ''{}''::jsonb, null)',
    'public._system_ingest_impl(''trusted'', ''{}''::jsonb, null)',
    'public.system_report_trusted(''{"source":"x1","operation":"fn/x","message":"m"}''::jsonb)',
    'public._report_system_error(''db'', ''x'', ''fn/x'')',
    'public._system_monitoring_maintenance()',
    'public._system_reapply_rules()',
    'public._system_redact(''x'')', 'public._system_cfg(''limits'')', 'public._system_pick_rule(''db'', ''x'', null, null)'] loop
    foreach v_res in array array['{"r":"authenticated","u":"mgr"}', '{"r":"authenticated","u":"ath"}', '{"r":"authenticated","u":"coach"}',
                                 '{"r":"authenticated","u":"super"}', '{"r":"service_role","u":null}']::jsonb[] loop
      if v_tbl like 'public.system_report_trusted%' and v_res ->> 'r' = 'service_role' then continue; end if;
      if not pg_temp.t138_denied(v_res ->> 'r', case when v_res ->> 'u' is null then null else pg_temp.t138_uid(v_res ->> 'u') end, 'select ' || v_tbl) then
        raise exception 'S5 FAILED: % could execute %', v_res, v_tbl;
      end if;
    end loop;
  end loop;
  raise notice 'S5 PASSED: managers/athletes/coaches/service_role cannot execute internal helpers; clients cannot call the trusted entry point';

  -- ===== S6: service_role: only the approved trusted entry point =====
  v_res := pg_temp.t138_json('service_role', null,
    'select to_jsonb(public.system_report_trusted(''{"source":"edge","subsystem":"documents","operation":"fn/s6","message":"svc","severity":"critical"}''::jsonb))');
  if not coalesce((v_res ->> 'accepted')::boolean, false) then raise exception 'S6 FAILED: service_role trusted report rejected: %', v_res; end if;
  if (select severity from public.system_issues where operation = 'fn/s6') <> 'critical' then
    raise exception 'S6 FAILED: trusted callers may declare critical';
  end if;
  foreach v_tbl in array array['system_issues', 'system_issue_events', 'system_issue_rules', 'system_monitoring_config'] loop
    if not pg_temp.t138_denied('service_role', null, 'select count(*) from public.' || v_tbl) then
      raise exception 'S6 FAILED: service_role has direct table access to public.%', v_tbl;
    end if;
  end loop;
  raise notice 'S6 PASSED: service_role can use only system_report_trusted (and may declare critical); no direct table access';

  -- ===== S7: lifecycle RPCs authorization =====
  foreach v_tbl in array array['athlete', 'coach', 'disabled manager'] loop
    v_res := pg_temp.t138_json('authenticated',
      case v_tbl when 'athlete' then v_ath when 'coach' then v_coach else v_mgr_dis end,
      format('select to_jsonb(public.system_issue_acknowledge(%L))', v_issue));
    if v_res ->> 'error' is distinct from 'forbidden' then raise exception 'S7 FAILED: % acknowledge => %', v_tbl, v_res; end if;
    v_res := pg_temp.t138_json('authenticated',
      case v_tbl when 'athlete' then v_ath when 'coach' then v_coach else v_mgr_dis end,
      format('select to_jsonb(public.system_issue_resolve(%L))', v_issue));
    if v_res ->> 'error' is distinct from 'forbidden' then raise exception 'S7 FAILED: % resolve => %', v_tbl, v_res; end if;
    v_res := pg_temp.t138_json('authenticated',
      case v_tbl when 'athlete' then v_ath when 'coach' then v_coach else v_mgr_dis end,
      format('select to_jsonb(public.system_issue_mute(%L))', v_issue));
    if v_res ->> 'error' is distinct from 'forbidden' then raise exception 'S7 FAILED: % mute => %', v_tbl, v_res; end if;
    v_res := pg_temp.t138_json('authenticated',
      case v_tbl when 'athlete' then v_ath when 'coach' then v_coach else v_mgr_dis end,
      format('select to_jsonb(public.system_issue_unmute(%L))', v_issue));
    if v_res ->> 'error' is distinct from 'forbidden' then raise exception 'S7 FAILED: % unmute => %', v_tbl, v_res; end if;
    v_res := pg_temp.t138_json('authenticated',
      case v_tbl when 'athlete' then v_ath when 'coach' then v_coach else v_mgr_dis end,
      format('select to_jsonb(public.system_issue_reopen(%L))', v_issue));
    if v_res ->> 'error' is distinct from 'forbidden' then raise exception 'S7 FAILED: % reopen => %', v_tbl, v_res; end if;
  end loop;
  if (select status from public.system_issues where id = v_issue) <> 'open' then raise exception 'S7 FAILED: a forbidden call changed the issue'; end if;
  v_res := pg_temp.t138_json('authenticated', v_mgr, format('select to_jsonb(public.system_issue_acknowledge(%L))', v_issue));
  if (v_res ->> 'ok')::boolean is not true then raise exception 'S7 FAILED: manager acknowledge => %', v_res; end if;
  v_res := pg_temp.t138_json('authenticated', v_mgr_super, format('select to_jsonb(public.system_issue_resolve(%L, ''manual_fixed''))', v_issue));
  if (v_res ->> 'ok')::boolean is not true then raise exception 'S7 FAILED: super-user manager resolve => %', v_res; end if;
  if (select actor_user_id from public.system_issue_transitions where issue_id = v_issue and kind = 'resolve') <> v_mgr_super then
    raise exception 'S7 FAILED: the resolve transition does not record the acting manager';
  end if;
  raise notice 'S7 PASSED: athlete / coach / disabled manager get forbidden and change nothing; active managers can act and are recorded';

  -- ===== S8: anon cannot call lifecycle or client ingestion (covered in S1); unauthenticated authenticated-role call =====
  v_res := pg_temp.t138_json('authenticated', null, 'select to_jsonb(public.report_client_error(''{"operation":"rpc/x","message":"m"}''::jsonb))');
  if (v_res ->> 'accepted')::boolean is not false or v_res ->> 'reason' <> 'unauthenticated' then
    raise exception 'S8 FAILED: authenticated role without a uid must be rejected: %', v_res;
  end if;
  raise notice 'S8 PASSED: client ingestion without a user identity is rejected';
end $$;

-- ===== CLIENT INGESTION FORGERY MATRIX (client ingestion enabled for these tests only) =====
update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';

do $$
declare
  v_ath uuid := pg_temp.t138_uid('ath');
  v_coach uuid := pg_temp.t138_uid('coach');
  v_mgr uuid := pg_temp.t138_uid('mgr');
  v_dis uuid := pg_temp.t138_uid('dis');
  v_res jsonb;
  v_i public.system_issues;
  v_e public.system_issue_events;
  v_n bigint;
  v_acc integer;
  v_blob text;
  v_k integer;
begin
  -- C0: disabled by default is covered structurally; with the switch on, athlete & coach may report.
  v_res := pg_temp.t138_json('authenticated', v_ath, 'select to_jsonb(public.report_client_error(''{"operation":"rpc/c0","message":"hello"}''::jsonb))');
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'C0 FAILED: athlete report rejected: %', v_res; end if;
  v_res := pg_temp.t138_json('authenticated', v_coach, 'select to_jsonb(public.report_client_error(''{"operation":"rpc/c0coach","message":"hello"}''::jsonb))');
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'C0 FAILED: coach report rejected: %', v_res; end if;
  v_res := pg_temp.t138_json('authenticated', v_dis, 'select to_jsonb(public.report_client_error(''{"operation":"rpc/c0dis","message":"hello"}''::jsonb))');
  if (v_res ->> 'accepted')::boolean is not false or v_res ->> 'reason' <> 'not_allowed' then
    raise exception 'C0 FAILED: a disabled account must not be able to report: %', v_res;
  end if;
  raise notice 'C0 PASSED: authenticated athletes and coaches may report (when enabled); disabled accounts may not';

  -- C1: forged user_id, source, severity, impact, lifecycle, rule, fingerprint, manager-notification fields.
  v_res := pg_temp.t138_json('authenticated', v_ath, format($j$select to_jsonb(public.report_client_error(%L::jsonb))$j$, jsonb_build_object(
    'operation', 'rpc/c1', 'message', 'forged', 'error_code', '42703',
    'user_id', v_mgr, 'user_role', 'manager', 'source', 'detector', 'subsystem', 'billing', 'severity', 'critical',
    'impact', 'financial_risk', 'manager_notifiable', true, 'manager_message', 'pay me', 'status', 'resolved',
    'resolution', 'manual_fixed', 'rule_id', gen_random_uuid(), 'rule', 'ignore', 'lifecycle', 'x',
    'fingerprint', md5('forged'), 'fingerprint_key', 'detector:forged', 'count', 100000, 'origin', 'forged')::text));
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'C1 FAILED: report rejected: %', v_res; end if;
  select * into v_i from public.system_issues where operation = 'rpc/c1';
  if v_i.source <> 'client' then raise exception 'C1 FAILED: source forged => %', v_i.source; end if;
  if v_i.severity <> 'error' or v_i.base_severity <> 'error' then raise exception 'C1 FAILED: client declared critical => %/%', v_i.base_severity, v_i.severity; end if;
  if v_i.impact is not null or v_i.status <> 'open' or v_i.resolution is not null or v_i.rule_id is not null then
    raise exception 'C1 FAILED: trusted fields were settable: impact=% status=% resolution=% rule=%', v_i.impact, v_i.status, v_i.resolution, v_i.rule_id;
  end if;
  if v_i.subsystem <> 'client' or v_i.reported_subsystem <> 'client' then raise exception 'C1 FAILED: subsystem forged => %', v_i.subsystem; end if;
  if v_i.fingerprint in (md5('forged'), md5('key' || chr(31) || 'detector:forged')) then raise exception 'C1 FAILED: forged fingerprint used'; end if;
  if v_i.occurrence_count <> 1 then raise exception 'C1 FAILED: client count forged => %', v_i.occurrence_count; end if;
  select * into v_e from public.system_issue_events where issue_id = v_i.id;
  if v_e.user_id <> v_ath or v_e.user_role <> 'athlete' then raise exception 'C1 FAILED: forged identity stored: % / %', v_e.user_id, v_e.user_role; end if;
  raise notice 'C1 PASSED: forged user_id/role, source, subsystem, critical, impact, lifecycle, rule, fingerprint and count are all ignored/clamped';

  -- C2: arbitrary context dropped; secrets redacted.
  v_res := pg_temp.t138_json('authenticated', v_ath, format($j$select to_jsonb(public.report_client_error(%L::jsonb))$j$, jsonb_build_object(
    'operation', 'rpc/c2', 'error_class', 'Error',
    'message', 'fail Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij password=Sup3rSecret mail me@x.com 0521234567 ?token=qq',
    'stack', E'Error: x\n at f (app://b.js:1:1)\n at refresh_token=r3fr35h (x)',
    'context', jsonb_build_object('http_status', 500, 'secret', 'shh', 'authorization', 'Bearer abc', 'cookie', 'a=b', 'phone', '0521234567',
                                  'health_declaration', 'yes', 'card', '4111111111111111', 'body', jsonb_build_object('a', 1)),
    'entities', jsonb_build_object('session_id', gen_random_uuid(), 'email', 'me@x.com'),
    'unknown_top', 'leak')::text));
  select * into v_i from public.system_issues where operation = 'rpc/c2';
  select row_to_json(i)::text || ' ' || coalesce((select string_agg(row_to_json(e)::text, ' ') from public.system_issue_events e where e.issue_id = i.id), '')
    into v_blob from public.system_issues i where i.id = v_i.id;
  if v_blob ~* 'eyJ' or v_blob ~* 'Sup3rSecret' or v_blob like '%me@x.com%' or v_blob ~ '0521234567' or v_blob ~ 'token=qq' or v_blob ~* 'r3fr35h'
     or v_blob ~* 'shh' or v_blob ~* '4111111111111111' or v_blob ~* 'leak' or v_blob ~* 'health_declaration' or v_blob ~* 'cookie' then
    raise exception 'C2 FAILED: a secret / arbitrary field was stored: %', left(v_blob, 600);
  end if;
  raise notice 'C2 PASSED: client secrets are redacted and arbitrary context / top-level fields are dropped';

  -- C3: injection strings are stored inertly (no dynamic SQL; tables intact).
  v_res := pg_temp.t138_json('authenticated', v_ath, format($j$select to_jsonb(public.report_client_error(%L::jsonb))$j$, jsonb_build_object(
    'operation', 'rpc/x''; drop table public.system_issues; --', 'error_class', 'E''; delete from public.profiles;--', 'error_code', '1; drop',
    'message', '''); drop table public.system_issues; -- " ' || chr(36) || chr(36) || ' ' || chr(92) || ' ', 'route', '/x''; drop', 'app_version', '1.0''; --')::text));
  if not exists (select 1 from pg_class where relname = 'system_issues' and relnamespace = 'public'::regnamespace) then
    raise exception 'C3 FAILED: injection dropped a table';
  end if;
  if (select count(*) from public.profiles) < 5 then raise exception 'C3 FAILED: injection touched profiles'; end if;
  if exists (select 1 from public.system_issues where operation like '%drop%') then raise exception 'C3 FAILED: an invalid operation was stored verbatim'; end if;
  raise notice 'C3 PASSED: injection strings in operation/class/code/message/route/version cannot execute and are not stored raw';

  -- C4: new-fingerprint flooding: one user may create at most 5 NEW issues per hour.
  v_acc := 0;
  for v_k in 1..9 loop
    v_res := pg_temp.t138_json('authenticated', v_mgr, format($j$select to_jsonb(public.report_client_error(%L::jsonb))$j$,
      jsonb_build_object('operation', 'rpc/c4_' || v_k, 'message', 'distinct failure number ' || v_k || ' ' || md5(v_k::text))::text));
    if (v_res ->> 'accepted')::boolean then v_acc := v_acc + 1; end if;
  end loop;
  select count(*) into v_n from public.system_issues where operation like 'rpc/c4\_%';
  if v_acc <> 5 or v_n <> 5 then raise exception 'C4 FAILED: accepted=% issues=% (expected 5/5)', v_acc, v_n; end if;
  if v_res ->> 'reason' <> 'user_new_fingerprints' then raise exception 'C4 FAILED: reason=%', v_res ->> 'reason'; end if;
  raise notice 'C4 PASSED: a single user can create only 5 new issues per hour (9 attempts => 5 issues)';

  -- C5: per-user report quota (20 / hour) on an existing issue.
  v_acc := 0;
  for v_k in 1..30 loop
    v_res := pg_temp.t138_json('authenticated', v_coach, '
      select to_jsonb(public.report_client_error(''{"operation":"rpc/c0coach","message":"hello"}''::jsonb))');
    if (v_res ->> 'accepted')::boolean then v_acc := v_acc + 1; end if;
  end loop;
  -- the coach already used 1 report in C0
  if v_acc <> 19 then raise exception 'C5 FAILED: accepted % more reports (expected 19 on top of the first)', v_acc; end if;
  if v_res ->> 'reason' <> 'user_quota' then raise exception 'C5 FAILED: reason=%', v_res ->> 'reason'; end if;
  raise notice 'C5 PASSED: per-user quota stops a user at 20 reports per hour';

  -- C6: global client new-issue limit.
  update public.system_monitoring_config set value = jsonb_set(value, '{client_new_issues_per_hour}', '3') where key = 'limits';
  delete from public.system_report_quota;
  v_acc := 0;
  for v_k in 1..8 loop
    -- different users each create one distinct issue; only the first 3 globally may be created
    v_res := pg_temp.t138_json('authenticated', case v_k % 4 when 0 then v_ath when 1 then v_coach when 2 then v_mgr else pg_temp.t138_uid('super') end,
      format($j$select to_jsonb(public.report_client_error(%L::jsonb))$j$, jsonb_build_object('operation', 'rpc/c6_' || v_k, 'message', 'global flood ' || v_k)::text));
    if (v_res ->> 'accepted')::boolean then v_acc := v_acc + 1; end if;
  end loop;
  if v_acc <> 3 then raise exception 'C6 FAILED: accepted % (expected 3)', v_acc; end if;
  if v_res ->> 'reason' <> 'global_new_fingerprints' then raise exception 'C6 FAILED: reason=%', v_res ->> 'reason'; end if;
  update public.system_monitoring_config set value = jsonb_set(value, '{client_new_issues_per_hour}', '100') where key = 'limits';
  raise notice 'C6 PASSED: the global client new-issue ceiling bounds distributed fingerprint flooding';

  -- C7: a client can never change a rule/config through ingestion; rules table untouched.
  if exists (select 1 from public.system_issue_rules) then raise exception 'C7 FAILED: rules changed'; end if;
  if (select value from public.system_monitoring_config where key = 'ingest_enabled') <> 'true'::jsonb then raise exception 'C7 FAILED: config changed'; end if;
  raise notice 'C7 PASSED: ingestion leaves rules and configuration untouched';

  -- C8: with the switch off (default) client reports are rejected before any work.
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
  v_n := (select count(*) from public.system_issues);
  v_res := pg_temp.t138_json('authenticated', v_ath, 'select to_jsonb(public.report_client_error(''{"operation":"rpc/c8","message":"x"}''::jsonb))');
  if (v_res ->> 'accepted')::boolean is not false or v_res ->> 'reason' <> 'disabled' then raise exception 'C8 FAILED: %', v_res; end if;
  if (select count(*) from public.system_issues) <> v_n then raise exception 'C8 FAILED: a disabled endpoint wrote data'; end if;
  raise notice 'C8 PASSED: with client_ingest_enabled=false the endpoint accepts nothing and writes nothing';

  raise notice 'ALL SYSTEM MONITORING SECURITY TESTS (S1-S8, C0-C8) PASSED';
end $$;

rollback;
