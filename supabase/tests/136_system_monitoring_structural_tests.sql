-- Permanent STRUCTURAL security test for the system monitoring Phase 1 objects
-- (20261006100000 / 20261006110000 / 20261006120000).
--
-- Project default privileges hand ALL on new tables and EXECUTE on new functions to anon, authenticated
-- and service_role, so RLS alone is never enough. This test inspects the catalog and FAILS CLOSED if a
-- later migration re-exposes any monitoring object: ownership, SECURITY DEFINER/INVOKER, pinned
-- search_path, PUBLIC / anon / authenticated / service_role EXECUTE, table and column grants, RLS and
-- policies, indexes, seed configuration, absence of any cron job and of any is_super_user dependency.
--
-- Pure catalog checks: no fixtures, no auth.users rows. Plain psql: any failure raises an exception.
set client_min_messages to notice;

do $$
declare
  v_tables constant text[] := array[
    'system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions',
    'system_issue_rules', 'system_monitoring_config', 'system_report_quota'];
  v_data constant text[] := array[
    'system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'];
  v_closed constant text[] := array['system_issue_rules', 'system_monitoring_config', 'system_report_quota'];
  v_t text;
  v_role text;
  v_found text[];
  v_cols text[];
  v_allowed_cols text[];
  v_n integer;
  r record;
begin
  -- T1: exactly these monitoring tables exist (a new system_* table must be reviewed and added here).
  select coalesce(array_agg(c.relname::text order by c.relname), '{}') into v_found
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname like 'system\_%';
  if v_found <> (select array_agg(x order by x) from unnest(v_tables) x) then
    raise exception 'T1 FAILED: system_* tables are %, expected %', v_found, v_tables;
  end if;
  raise notice 'T1 PASSED: the 7 approved monitoring tables exist and no others';

  -- T2: ownership, RLS enabled.
  foreach v_t in array v_tables loop
    if pg_get_userbyid((select relowner from pg_class where oid = ('public.' || v_t)::regclass)) <> 'postgres' then
      raise exception 'T2 FAILED: public.% is not owned by postgres', v_t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_t)::regclass) then
      raise exception 'T2 FAILED: RLS disabled on public.%', v_t;
    end if;
  end loop;
  raise notice 'T2 PASSED: all monitoring tables are owned by postgres with RLS enabled';

  -- T3: table privileges. anon / service_role / PUBLIC: nothing. authenticated: no table-level privilege
  -- and no write privilege on any column, ever.
  foreach v_t in array v_tables loop
    foreach v_role in array array['anon', 'service_role'] loop
      if has_table_privilege(v_role, ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(v_role, ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'T3 FAILED: % has a privilege on public.%', v_role, v_t;
      end if;
    end loop;
    if has_table_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'T3 FAILED: authenticated has a table-level privilege on public.%', v_t;
    end if;
    if has_any_column_privilege('authenticated', ('public.' || v_t)::regclass, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'T3 FAILED: authenticated has a column write privilege on public.%', v_t;
    end if;
    if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               where c.oid = ('public.' || v_t)::regclass and a.grantee = 0) then
      raise exception 'T3 FAILED: PUBLIC has a privilege on public.%', v_t;
    end if;
  end loop;
  foreach v_t in array v_closed loop
    if has_any_column_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT') then
      raise exception 'T3 FAILED: authenticated can read the closed table public.%', v_t;
    end if;
  end loop;
  raise notice 'T3 PASSED: no anon/service_role/PUBLIC access; authenticated has no writes and no access to rules/config/quota';

  -- T3b: sequences (identity columns) are objects too: the project's default privileges grant ALL on new
  -- sequences to anon / authenticated / service_role. No API role may hold any privilege on a
  -- monitoring sequence, and every sequence in public owned by a monitoring table is covered.
  if not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and c.relname like 'system\_%') then
    raise exception 'T3b FAILED: expected the identity sequence of system_issue_transitions';
  end if;
  for r in
    select c.oid, c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
      and (c.relname like 'system\_%' or exists (select 1 from pg_depend d join pg_class t on t.oid = d.refobjid
                                                 where d.objid = c.oid and t.relname like 'system\_%'))
  loop
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_sequence_privilege(v_role, r.oid, 'USAGE,SELECT,UPDATE') then
        raise exception 'T3b FAILED: % has a privilege on sequence %', v_role, r.relname;
      end if;
    end loop;
  end loop;
  raise notice 'T3b PASSED: no API role has any privilege on monitoring sequences';

  -- T4: the readable column set of each data table equals the reviewed allowlist EXACTLY (fail closed:
  -- a column added later is not readable until this list is deliberately extended).
  for v_t, v_allowed_cols in
    select * from (values
      ('system_issues', array['acknowledged_at','acknowledged_by','base_severity','created_at','error_class','error_code','fingerprint','first_seen','first_seen_version','id','impact','last_seen','last_seen_version','latest_summary','muted_until','occurrence_count','operation','regressed_in_version','reopen_count','reopened_at','reported_subsystem','resolution','resolved_at','resolved_by','resolved_version','rule_id','severity','source','status','subsystem','title']),
      ('system_issue_events', array['app_version','build','coalesced_count','context','entities','env','id','issue_id','message','occurred_at','platform','route','sample_reason','severity','stack','user_id','user_role']),
      ('system_issue_buckets', array['breaker_tripped_at','bucket_start','count','issue_id','sampled']),
      ('system_issue_transitions', array['actor_user_id','at','from_status','id','issue_id','kind','reason','to_status'])
    ) x(t, c)
  loop
    select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
    where a.attrelid = ('public.' || v_t)::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', ('public.' || v_t)::regclass, a.attname, 'SELECT');
    if v_cols <> (select array_agg(x order by x) from unnest(v_allowed_cols) x) then
      raise exception 'T4 FAILED: readable columns of public.% are %, expected %', v_t, v_cols, v_allowed_cols;
    end if;
    -- and every column of the table is accounted for (no hidden column)
    select count(*) into v_n from pg_attribute a
    where a.attrelid = ('public.' || v_t)::regclass and a.attnum > 0 and not a.attisdropped;
    if v_n <> cardinality(v_allowed_cols) then
      raise exception 'T4 FAILED: public.% has % columns but the allowlist has %', v_t, v_n, cardinality(v_allowed_cols);
    end if;
  end loop;
  raise notice 'T4 PASSED: readable column sets equal the reviewed allowlists exactly';

  -- T5: policies: exactly one SELECT policy per data table (authenticated + manager gate), none elsewhere.
  foreach v_t in array v_data loop
    select count(*) into v_n from pg_policies p
    where p.schemaname = 'public' and p.tablename = v_t;
    if v_n <> 1 then
      raise exception 'T5 FAILED: public.% has % policies, expected exactly 1', v_t, v_n;
    end if;
    if not exists (select 1 from pg_policies p
                   where p.schemaname = 'public' and p.tablename = v_t and p.cmd = 'SELECT'
                     and p.roles = '{authenticated}'::name[]
                     and p.qual like '%system_monitoring_is_manager()%') then
      raise exception 'T5 FAILED: public.% policy is not a SELECT policy gated on system_monitoring_is_manager()', v_t;
    end if;
  end loop;
  foreach v_t in array v_closed loop
    if exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = v_t) then
      raise exception 'T5 FAILED: the closed table public.% must have no policies', v_t;
    end if;
  end loop;
  raise notice 'T5 PASSED: one manager-gated SELECT policy per data table; none on rules/config/quota';

  -- T6: indexes on system_issues (no index on last_seen / occurrence_count: keeps updates HOT).
  select coalesce(array_agg(i.indexname::text order by i.indexname), '{}') into v_found
  from pg_indexes i where i.schemaname = 'public' and i.tablename = 'system_issues';
  if v_found <> array['system_issues_active_idx', 'system_issues_fingerprint_key', 'system_issues_pkey', 'system_issues_resolved_at_idx'] then
    raise exception 'T6 FAILED: indexes on system_issues are %', v_found;
  end if;
  if not exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.tablename = 'system_issues'
                 and i.indexdef like 'CREATE UNIQUE INDEX system_issues_fingerprint_key%(fingerprint)%') then
    raise exception 'T6 FAILED: fingerprint is not uniquely indexed';
  end if;
  raise notice 'T6 PASSED: system_issues indexes are exactly the reviewed set; fingerprint is unique';
end $$;

-- T7..T10: functions.
do $$
declare
  r record;
  v_role text;
  v_auth boolean;
  v_svc boolean;
  v_def boolean;
  v_expected constant text[] := array[
    '_report_system_error', '_system_cfg', '_system_fingerprint', '_system_flag', '_system_ingest',
    '_system_ingest_impl', '_system_limit', '_system_monitoring_maintenance', '_system_normalize_template',
    '_system_pick_rule', '_system_pick_text', '_system_rank_sev', '_system_reapply_rules', '_system_redact',
    '_system_ret', '_system_sanitize_map', '_system_sev_rank', '_system_stack_origin',
    'report_client_error', 'system_issue_acknowledge', 'system_issue_mute', 'system_issue_reopen',
    'system_issue_resolve', 'system_issue_unmute', 'system_monitoring_is_manager', 'system_report_trusted'];
  v_found text[];
  v_n integer := 0;
begin
  -- T7: the monitoring function set is exactly the reviewed one.
  select coalesce(array_agg(distinct p.proname::text order by p.proname::text), '{}') into v_found
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (p.proname like '\_system\_%' or p.proname like 'system\_%' or p.proname in ('report_client_error', '_report_system_error'));
  if v_found <> (select array_agg(x order by x) from unnest(v_expected) x) then
    raise exception 'T7 FAILED: monitoring functions are %, expected %', v_found, v_expected;
  end if;
  raise notice 'T7 PASSED: the monitoring function set is exactly the approved 26 functions';

  -- T8: ownership, definer/invoker, pinned search_path, EXECUTE matrix.
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any (v_expected)
  loop
    v_n := v_n + 1;
    if r.owner <> 'postgres' then raise exception 'T8 FAILED: % owner is %', r.sig, r.owner; end if;
    if r.proconfig is null or not ('search_path=public, pg_temp' = any (r.proconfig)) then
      raise exception 'T8 FAILED: % does not pin search_path to public, pg_temp', r.sig;
    end if;
    -- SECURITY INVOKER helpers vs SECURITY DEFINER entry points / workers
    v_def := r.proname not in ('_system_sev_rank', '_system_rank_sev', '_system_cfg', '_system_limit', '_system_flag',
      '_system_redact', '_system_normalize_template', '_system_sanitize_map', '_system_fingerprint',
      '_system_pick_rule', '_system_pick_text', '_system_stack_origin', '_system_ret');
    if r.prosecdef <> v_def then
      raise exception 'T8 FAILED: % has prosecdef=% (expected %)', r.sig, r.prosecdef, v_def;
    end if;
    foreach v_role in array array['public', 'anon'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        raise exception 'T8 FAILED: % is executable by %', r.sig, v_role;
      end if;
    end loop;
    v_auth := r.proname in ('system_monitoring_is_manager', 'report_client_error', 'system_issue_acknowledge',
      'system_issue_resolve', 'system_issue_mute', 'system_issue_unmute', 'system_issue_reopen');
    v_svc := r.proname = 'system_report_trusted';
    if has_function_privilege('authenticated', r.oid, 'EXECUTE') <> v_auth then
      raise exception 'T8 FAILED: % authenticated EXECUTE should be %', r.sig, v_auth;
    end if;
    if has_function_privilege('service_role', r.oid, 'EXECUTE') <> v_svc then
      raise exception 'T8 FAILED: % service_role EXECUTE should be %', r.sig, v_svc;
    end if;
    -- no PUBLIC grantee in the ACL at all
    if exists (select 1 from pg_proc q, aclexplode(coalesce(q.proacl, acldefault('f', q.proowner))) a
               where q.oid = r.oid and a.grantee = 0) then
      raise exception 'T8 FAILED: % has a PUBLIC grantee', r.sig;
    end if;
  end loop;
  if v_n <> 26 then raise exception 'T8 FAILED: inspected % functions, expected 26', v_n; end if;
  raise notice 'T8 PASSED: ownership, definer/invoker, search_path and the full EXECUTE matrix are exact (26 functions)';

  -- T9: the monitoring authorization model must not depend on is_super_user or on the arbitrary-uid
  -- is_manager(uid) helper, in any function or policy.
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any (v_expected)
      and (pg_get_functiondef(p.oid) ~* '\yis_super_user' or pg_get_functiondef(p.oid) ~* '\yis_manager\s*\(')
  ) then
    raise exception 'T9 FAILED: a monitoring function references is_super_user or is_manager(uid)';
  end if;
  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename like 'system\_%'
      and (coalesce(p.qual, '') ~* '\yis_super_user' or coalesce(p.qual, '') ~* '\yis_manager\s*\(' or coalesce(p.with_check, '') ~* 'is_super_user')
  ) then
    raise exception 'T9 FAILED: a monitoring policy references is_super_user or is_manager(uid)';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any (v_expected)
      and pg_get_functiondef(p.oid) ~* 'app_kv_settings'
  ) then
    raise exception 'T9 FAILED: a monitoring function reads app_kv_settings (manager-writable) as configuration';
  end if;
  -- The authorization helper itself: role = manager AND disabled_at IS NULL, zero arguments.
  if (select pronargs from pg_proc where oid = 'public.system_monitoring_is_manager()'::regprocedure) <> 0 then
    raise exception 'T9 FAILED: system_monitoring_is_manager must take no arguments';
  end if;
  if pg_get_functiondef('public.system_monitoring_is_manager()'::regprocedure) not like '%disabled_at is null%'
     or pg_get_functiondef('public.system_monitoring_is_manager()'::regprocedure) not like '%''manager''%' then
    raise exception 'T9 FAILED: system_monitoring_is_manager must require role manager and disabled_at IS NULL';
  end if;
  raise notice 'T9 PASSED: no is_super_user / is_manager(uid) / app_kv_settings dependency; the gate requires manager AND not disabled';

  -- T10: no dynamic SQL in ingestion / lifecycle code (injection surface = none).
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any (v_expected)
      and pg_get_functiondef(p.oid) ~* '\yexecute\s+(format|[''a-z_(])'
  ) then
    raise exception 'T10 FAILED: a monitoring function uses dynamic SQL';
  end if;
  raise notice 'T10 PASSED: monitoring functions contain no dynamic SQL';
end $$;

-- T11..T14: configuration seed, scheduling, wiring.
do $$
declare
  v_keys text[];
  v_cron boolean;
begin
  select coalesce(array_agg(c.key order by c.key), '{}') into v_keys from public.system_monitoring_config c;
  if v_keys <> array['client_ingest_enabled', 'context_allowed_keys', 'ingest_enabled', 'limits', 'retention'] then
    raise exception 'T11 FAILED: config keys are %', v_keys;
  end if;
  if (select value from public.system_monitoring_config where key = 'client_ingest_enabled') <> 'false'::jsonb then
    raise exception 'T11 FAILED: client_ingest_enabled must be false in Phase 1';
  end if;
  if (select value from public.system_monitoring_config where key = 'ingest_enabled') <> 'true'::jsonb then
    raise exception 'T11 FAILED: ingest_enabled must be true';
  end if;
  raise notice 'T11 PASSED: config contains exactly the 5 seeded keys; client ingestion is disabled by default';

  -- No cron job references the monitoring system (maintenance is built but not scheduled).
  select exists (select 1 from cron.job j where j.command ~* '(_system_|system_issue|system_monitoring|_report_system_error|report_client_error)') into v_cron;
  if v_cron then
    raise exception 'T12 FAILED: a cron job references the monitoring system';
  end if;
  raise notice 'T12 PASSED: no pg_cron job references the monitoring system';

  -- Not wired into Realtime.
  if exists (select 1 from pg_publication_tables t where t.schemaname = 'public' and t.tablename like 'system\_%') then
    raise exception 'T13 FAILED: a monitoring table is in a Realtime publication';
  end if;
  raise notice 'T13 PASSED: monitoring tables are not published to Realtime';

  -- Rules/config/quota are empty or seeded only; no triggers are attached to monitoring tables
  -- (no recursion surface, no hidden side effects).
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
             where c.relnamespace = 'public'::regnamespace and c.relname like 'system\_%' and not t.tgisinternal) then
    raise exception 'T14 FAILED: a user trigger exists on a monitoring table';
  end if;
  raise notice 'T14 PASSED: no user triggers on monitoring tables';

  raise notice 'ALL SYSTEM MONITORING STRUCTURAL TESTS (T1-T14) PASSED';
end $$;
