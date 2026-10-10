-- System monitoring Phase 2.1: system_job_state structure + REAL-ROLE security tests.
--
-- Covers: owner/RLS, exact ACLs (table + every column + sequences), readable column set (everything except
-- cursor), active manager can read, manager cannot read cursor / mutate state / modify config, disabled
-- manager / athlete / coach / anon / service_role cannot read, seed rows, shadow-mode configuration, the
-- observer functions are not executable by any API role, and no business cron job was touched.
-- Self-contained: own auth.users fixtures; everything is rolled back.
set client_min_messages to notice;
begin;

create temp table t142_fx (k text primary key, v uuid);

create function pg_temp.t142_denied(p_role text, p_uid uuid, p_sql text) returns boolean language plpgsql as $f$
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

create function pg_temp.t142_scalar(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute 'set local role ' || quote_ident(p_role);
  execute p_sql into v;
  execute 'reset role';
  return v;
end $f$;

do $$
declare
  v_ath uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_dis uuid := gen_random_uuid();
  v_role text;
  v_col text;
  v_n bigint;
  v_cols text[];
  r record;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_ath, 't142-ath@test.local', '0501420001'), (v_coach, 't142-coach@test.local', '0501420002'),
               (v_mgr, 't142-mgr@test.local', '0501420003'), (v_dis, 't142-dis@test.local', '0501420004')) u(id, e, p);
  update public.profiles set approval_status = 'approved' where user_id in (v_ath, v_coach, v_mgr, v_dis);
  update public.profiles set role = 'coach' where user_id = v_coach;
  update public.profiles set role = 'manager' where user_id in (v_mgr, v_dis);
  update public.profiles set disabled_at = now() where user_id = v_dis;

  -- S1: owner + RLS.
  if pg_get_userbyid((select relowner from pg_class where oid = 'public.system_job_state'::regclass)) <> 'postgres' then
    raise exception 'S1 FAILED: owner';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.system_job_state'::regclass) then
    raise exception 'S1 FAILED: RLS off';
  end if;
  raise notice 'S1 PASSED: owned by postgres, RLS enabled';

  -- S2: exact ACL. No table-level privilege for anyone; anon/service_role nothing at all; authenticated
  -- SELECT on every column except cursor, and nothing else.
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(v_role, 'public.system_job_state'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'S2 FAILED: % has a table-level privilege', v_role;
    end if;
  end loop;
  foreach v_role in array array['anon', 'service_role'] loop
    if has_any_column_privilege(v_role, 'public.system_job_state'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'S2 FAILED: % has a column privilege', v_role;
    end if;
  end loop;
  for v_col in select a.attname::text from pg_attribute a
               where a.attrelid = 'public.system_job_state'::regclass and a.attnum > 0 and not a.attisdropped loop
    if has_column_privilege('authenticated', 'public.system_job_state'::regclass, v_col, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'S2 FAILED: authenticated can write/reference column %', v_col;
    end if;
    if has_column_privilege('authenticated', 'public.system_job_state'::regclass, v_col, 'SELECT') <> (v_col <> 'cursor') then
      raise exception 'S2 FAILED: authenticated SELECT on column % is wrong', v_col;
    end if;
  end loop;
  -- the raw ACL contains no grantee other than the owner and authenticated
  select count(*) into v_n from (
    select (aclexplode(c.relacl)).grantee as g from pg_class c where c.oid = 'public.system_job_state'::regclass
    union all
    select (aclexplode(a.attacl)).grantee from pg_attribute a where a.attrelid = 'public.system_job_state'::regclass and a.attacl is not null
  ) x where x.g not in (0, 'postgres'::regrole::oid, 'authenticated'::regrole::oid);
  -- grantee 0 = PUBLIC must not appear either
  select count(*) into v_n from (
    select (aclexplode(c.relacl)).grantee as g from pg_class c where c.oid = 'public.system_job_state'::regclass
    union all
    select (aclexplode(a.attacl)).grantee from pg_attribute a where a.attrelid = 'public.system_job_state'::regclass and a.attacl is not null
  ) x where x.g <> 'postgres'::regrole::oid and x.g <> 'authenticated'::regrole::oid;
  if v_n <> 0 then raise exception 'S2 FAILED: unexpected grantee in ACL (% entries)', v_n; end if;
  raise notice 'S2 PASSED: exact table/column ACL (authenticated SELECT on all columns except cursor; no other grantee)';

  -- S3: sequences: none for this table; no API role holds any privilege on any monitoring sequence.
  select count(*) into v_n from pg_class c join pg_depend d on d.objid = c.oid and d.refobjid = 'public.system_job_state'::regclass
  where c.relkind = 'S';
  if v_n <> 0 then raise exception 'S3 FAILED: sequence tied to system_job_state'; end if;
  for r in select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and c.relname like 'system\_%' loop
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_sequence_privilege(v_role, r.oid, 'USAGE,SELECT,UPDATE') then
        raise exception 'S3 FAILED: % has privilege on sequence %', v_role, r.relname;
      end if;
    end loop;
  end loop;
  raise notice 'S3 PASSED: no sequence for system_job_state; no sequence privilege for any API role';

  -- S4: exactly one policy, manager-gated SELECT.
  select count(*) into v_n from pg_policy where polrelid = 'public.system_job_state'::regclass and polcmd = 'r';
  if v_n <> 1 or (select count(*) from pg_policy where polrelid = 'public.system_job_state'::regclass) <> 1 then
    raise exception 'S4 FAILED: policies are not exactly one SELECT policy';
  end if;
  if pg_get_expr((select polqual from pg_policy where polrelid = 'public.system_job_state'::regclass), 'public.system_job_state'::regclass)
       !~ 'system_monitoring_is_manager' then
    raise exception 'S4 FAILED: policy is not gated by system_monitoring_is_manager()';
  end if;
  raise notice 'S4 PASSED: one manager-gated SELECT policy';

  -- S5: read access by role.
  if pg_temp.t142_scalar('authenticated', v_mgr, 'select count(*) from public.system_job_state') <> 8 then
    raise exception 'S5 FAILED: an active manager must see all 8 rows';
  end if;
  if pg_temp.t142_scalar('authenticated', v_mgr, 'select count(*) from (select job_key, shadow, last_result, last_outcome, stale from public.system_job_state) x') <> 8 then
    raise exception 'S5 FAILED: explicit safe columns must be readable';
  end if;
  if pg_temp.t142_scalar('authenticated', v_dis, 'select count(*) from public.system_job_state') <> 0 then
    raise exception 'S5 FAILED: disabled manager sees rows';
  end if;
  if pg_temp.t142_scalar('authenticated', v_ath, 'select count(*) from public.system_job_state') <> 0 then
    raise exception 'S5 FAILED: athlete sees rows';
  end if;
  if pg_temp.t142_scalar('authenticated', v_coach, 'select count(*) from public.system_job_state') <> 0 then
    raise exception 'S5 FAILED: coach sees rows';
  end if;
  if pg_temp.t142_scalar('authenticated', null, 'select count(*) from public.system_job_state') <> 0 then
    raise exception 'S5 FAILED: authenticated without a user id sees rows';
  end if;
  if not pg_temp.t142_denied('anon', null, 'select count(*) from public.system_job_state') then
    raise exception 'S5 FAILED: anon can read';
  end if;
  if not pg_temp.t142_denied('service_role', null, 'select count(*) from public.system_job_state') then
    raise exception 'S5 FAILED: service_role can read';
  end if;
  raise notice 'S5 PASSED: active manager reads; disabled manager / athlete / coach / no-uid see nothing; anon and service_role denied';

  -- S6: cursor is invisible in every form.
  foreach v_col in array array['select cursor from public.system_job_state', 'select * from public.system_job_state',
                               'select t.cursor from public.system_job_state t', 'select to_jsonb(t) from public.system_job_state t',
                               'select s from public.system_job_state s'] loop
    if v_col in ('select to_jsonb(t) from public.system_job_state t', 'select s from public.system_job_state s') then
      -- whole-row references need every column privilege: must be denied too
      if not pg_temp.t142_denied('authenticated', v_mgr, v_col) then raise exception 'S6 FAILED: whole-row read allowed: %', v_col; end if;
    elsif not pg_temp.t142_denied('authenticated', v_mgr, v_col) then
      raise exception 'S6 FAILED: manager can read cursor via: %', v_col;
    end if;
  end loop;
  raise notice 'S6 PASSED: a manager cannot read cursor (direct, *, alias, whole-row)';

  -- S7: managers cannot mutate state or config; nobody API-facing can touch other tables used here.
  foreach v_col in array array[
    'update public.system_job_state set monitored = false', 'update public.system_job_state set stale = true',
    'update public.system_job_state set shadow = ''{}''', 'insert into public.system_job_state (job_key) values (''x-hack'')',
    'delete from public.system_job_state', 'truncate public.system_job_state',
    'select * from public.system_monitoring_config', 'update public.system_monitoring_config set value = ''{}''',
    'delete from public.system_monitoring_config'] loop
    if not pg_temp.t142_denied('authenticated', v_mgr, v_col) then
      raise exception 'S7 FAILED: a manager was not denied: %', v_col;
    end if;
    if v_col like 'update%' or v_col like 'insert%' or v_col like 'delete%' or v_col like 'truncate%' then
      if not pg_temp.t142_denied('anon', null, v_col) or not pg_temp.t142_denied('service_role', null, v_col) then
        raise exception 'S7 FAILED: anon/service_role were not denied: %', v_col;
      end if;
    end if;
  end loop;
  raise notice 'S7 PASSED: managers (and anon/service_role) cannot mutate job state or config';

  -- S8: no API role can run any observer function.
  for r in select p.oid, p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('_system_job_observe', '_system_jobcfg_int', '_system_jobcfg_bool', '_system_jobcfg_paused_until',
                               '_system_job_key', '_system_job_stale_after_s', '_system_cron_jobs', '_system_cron_max_runid',
                               '_system_cron_runs', '_system_cron_recent_runs', '_system_jobcfg_text', '_system_job_issue_mode', '_system_job_issue_severity',
                               '_system_job_issue_message', '_system_job_issue_key', '_system_job_issue_payload', '_system_issue_auto_recover', '_system_job_report_cycle') loop
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then raise exception 'S8 FAILED: % executes %', v_role, r.sig; end if;
    end loop;
  end loop;
  if not pg_temp.t142_denied('authenticated', v_mgr, 'select public._system_job_observe()') then
    raise exception 'S8 FAILED: a manager can call the observer';
  end if;
  if not pg_temp.t142_denied('authenticated', v_mgr, 'select * from public._system_cron_jobs()') then
    raise exception 'S8 FAILED: a manager can read cron data through an adapter';
  end if;
  raise notice 'S8 PASSED: no API role can execute any observer function or adapter';

  -- S9: seeds + shadow configuration.
  select array_agg(job_key order by job_key) into v_cols from public.system_job_state;
  if v_cols <> array['birthday-direct-messages', 'generate-subscription-charges', 'maintain-session-series-horizon',
                     'open-weekly-registrations', 'push-session-reminders', 'system-monitor-observe',
                     'whatsapp-dispatch-notifications', 'whatsapp-session-reminders'] then
    raise exception 'S9 FAILED: seeded jobs are %', v_cols;
  end if;
  if exists (select 1 from public.system_job_state where last_business_success_at is not null) then
    raise exception 'S9 FAILED: last_business_success_at must never be fabricated';
  end if;
  if (select value ->> 'shadow' from public.system_monitoring_config where key = 'job_monitoring') <> 'true'
     or (select value ->> 'report_enabled' from public.system_monitoring_config where key = 'job_monitoring') <> 'false' then
    raise exception 'S9 FAILED: shadow=true / report_enabled=false expected';
  end if;
  if (select value from public.system_monitoring_config where key = 'client_ingest_enabled') <> 'false'::jsonb then
    raise exception 'S9 FAILED: client ingestion must remain disabled';
  end if;
  raise notice 'S9 PASSED: 8 seeded jobs by name, no fabricated business success, shadow=true, report_enabled=false, client ingestion disabled';

  -- S10: the observer is the only monitoring cron job; business cron jobs are not wrapped by the monitor.
  if (select count(*) from cron.job where command ~* '_system_|system_job_state|system_issue') > 1 then
    raise exception 'S10 FAILED: more than one cron job references monitoring';
  end if;
  if exists (select 1 from cron.job where jobname <> 'system-monitor-observe' and command ~* '_system_|system_job_state|system_issue') then
    raise exception 'S10 FAILED: a business cron job references monitoring (wrapper deployed?)';
  end if;
  raise notice 'S10 PASSED: only the observer references monitoring; no business job is wrapped';

  raise notice 'ALL SYSTEM JOB STATE SECURITY TESTS (S1-S10) PASSED';
end $$;

rollback;
