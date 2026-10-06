-- System monitoring Phase 1: flood control (persisted-row counts) and failure isolation.
--
-- Measures what is actually PERSISTED for 1 / 10 / 1,000 / 20,000 identical reports, many distinct
-- fingerprints from one user, and a many-users flood through the client boundary; then proves that
-- monitoring failures (malformed / oversized payloads, malformed configuration, malformed rules,
-- internal failure, disabled monitoring, re-entrancy) never propagate into the caller.
-- Self-contained; everything is rolled back.
set client_min_messages to notice;
begin;

create temp table t140_fx (k text primary key, v uuid);
create temp table t140_biz (n integer);

create function pg_temp.t140_rows() returns text language sql as $$
  select format('issues=%s events=%s buckets=%s transitions=%s quota=%s',
    (select count(*) from public.system_issues), (select count(*) from public.system_issue_events),
    (select count(*) from public.system_issue_buckets), (select count(*) from public.system_issue_transitions),
    (select count(*) from public.system_report_quota))
$$;

create function pg_temp.t140_reset() returns void language sql as $$
  delete from public.system_issues; delete from public.system_report_quota;
$$;

-- identical trusted reports; returns (accepted, rejected)
create function pg_temp.t140_flood(p_n integer, out accepted integer, out rejected integer) language plpgsql as $$
declare i integer; r jsonb;
begin
  accepted := 0; rejected := 0;
  for i in 1..p_n loop
    r := public._system_ingest('trusted', '{"source":"edge","subsystem":"notifications","operation":"fn/flood","error_code":"500","message":"provider exploded for request 12345678","severity":"error"}'::jsonb, null);
    if (r ->> 'accepted')::boolean then accepted := accepted + 1; else rejected := rejected + 1; end if;
  end loop;
end $$;

do $$
declare
  v_a integer; v_r integer;
  v_i public.system_issues;
  v_b public.system_issue_buckets;
  v_ev bigint;
  v_t timestamptz;
  v_ms numeric;
begin
  -- ================= FLOOD CONTROL (trusted path; no per-user quota) =================
  -- N = 1
  select * into v_a, v_r from pg_temp.t140_flood(1);
  select * into v_i from public.system_issues;
  select count(*) into v_ev from public.system_issue_events;
  if (select count(*) from public.system_issues) <> 1 or v_ev <> 1 or (select count(*) from public.system_issue_buckets) <> 1
     or (select count(*) from public.system_issue_transitions) <> 1 or v_i.occurrence_count <> 1 then
    raise exception 'FL1 FAILED: %', pg_temp.t140_rows();
  end if;
  raise notice 'FL1 PASSED (1 occurrence): %', pg_temp.t140_rows();

  -- N = 10
  perform pg_temp.t140_reset();
  select * into v_a, v_r from pg_temp.t140_flood(10);
  select * into v_i from public.system_issues; select * into v_b from public.system_issue_buckets;
  select count(*) into v_ev from public.system_issue_events;
  if v_i.occurrence_count <> 10 or v_b.count <> 10 or v_ev <> 5 or v_b.sampled <> 5 or (select count(*) from public.system_issues) <> 1 then
    raise exception 'FL10 FAILED: occ=% bucket=% events=% sampled=%', v_i.occurrence_count, v_b.count, v_ev, v_b.sampled;
  end if;
  raise notice 'FL10 PASSED (10 occurrences): % | occurrence_count=% events<=5 (%)', pg_temp.t140_rows(), v_i.occurrence_count, v_ev;

  -- N = 1,000
  perform pg_temp.t140_reset();
  v_t := clock_timestamp();
  select * into v_a, v_r from pg_temp.t140_flood(1000);
  v_ms := extract(epoch from clock_timestamp() - v_t) * 1000;
  select * into v_i from public.system_issues; select * into v_b from public.system_issue_buckets;
  select count(*) into v_ev from public.system_issue_events;
  if v_a <> 1000 or v_i.occurrence_count <> 1000 or v_b.count <> 1000 or v_ev <> 5 or v_b.breaker_tripped_at is not null
     or (select count(*) from public.system_issues) <> 1 then
    raise exception 'FL1000 FAILED: accepted=% occ=% bucket=% events=% tripped=%', v_a, v_i.occurrence_count, v_b.count, v_ev, v_b.breaker_tripped_at;
  end if;
  raise notice 'FL1000 PASSED (1,000 occurrences): % | accepted=% rejected=% (% ms total)', pg_temp.t140_rows(), v_a, v_r, round(v_ms);

  -- N = 20,000
  perform pg_temp.t140_reset();
  v_t := clock_timestamp();
  select * into v_a, v_r from pg_temp.t140_flood(20000);
  v_ms := extract(epoch from clock_timestamp() - v_t) * 1000;
  select * into v_i from public.system_issues; select * into v_b from public.system_issue_buckets;
  select count(*) into v_ev from public.system_issue_events;
  if v_a <> 1000 or v_r <> 19000 or v_i.occurrence_count <> 1000 or v_b.count <> 1000 or v_ev <> 5 or v_b.breaker_tripped_at is null
     or (select count(*) from public.system_issues) <> 1 or (select count(*) from public.system_issue_buckets) <> 1
     or (select count(*) from public.system_issue_transitions) <> 1 then
    raise exception 'FL20000 FAILED: accepted=% rejected=% occ=% bucket=% events=% tripped=%', v_a, v_r, v_i.occurrence_count, v_b.count, v_ev, v_b.breaker_tripped_at;
  end if;
  raise notice 'FL20000 PASSED (20,000 occurrences in one hour): % | accepted=% throttled=% breaker_tripped=yes (% ms total, % ms/report)', pg_temp.t140_rows(), v_a, v_r, round(v_ms), round(v_ms / 20000, 3);

  -- A trusted batched report counts as N occurrences with ONE event row.
  perform pg_temp.t140_reset();
  perform public._system_ingest('trusted', '{"source":"cron","subsystem":"recurring_sessions","operation":"cron/horizon","message":"3 dates unresolved","count":500,"fingerprint_key":"series_unresolved:slot1"}'::jsonb, null);
  perform public._system_ingest('trusted', '{"source":"cron","subsystem":"recurring_sessions","operation":"cron/horizon","message":"3 dates unresolved","count":500,"fingerprint_key":"series_unresolved:slot1"}'::jsonb, null);
  select * into v_i from public.system_issues;
  if v_i.occurrence_count <> 1000 or (select count(*) from public.system_issue_events) <> 2 then
    raise exception 'FLB FAILED: occ=% events=%', v_i.occurrence_count, (select count(*) from public.system_issue_events);
  end if;
  raise notice 'FLB PASSED: batched reports (count=500 each) => occurrence_count=1000 with 2 event rows (the old flood wrote one row per occurrence)';

  -- Many distinct fingerprints from the trusted path are bounded by the hourly new-issue ceiling.
  perform pg_temp.t140_reset();
  update public.system_monitoring_config set value = jsonb_set(value, '{trusted_new_issues_per_hour}', '50') where key = 'limits';
  v_a := 0;
  for v_ev in 1..200 loop
    if ((public._system_ingest('trusted', jsonb_build_object('source', 'edge', 'operation', 'fn/many', 'message', 'distinct failure kind ' || chr(65 + (v_ev % 26)) || chr(97 + ((v_ev / 26) % 26)) || chr(65 + ((v_ev / 676) % 26)) || ' text'), null)) ->> 'accepted')::boolean then
      v_a := v_a + 1;
    end if;
  end loop;
  if (select count(*) from public.system_issues) > 50 then raise exception 'FLM FAILED: % issues created', (select count(*) from public.system_issues); end if;
  update public.system_monitoring_config set value = jsonb_set(value, '{trusted_new_issues_per_hour}', '500') where key = 'limits';
  raise notice 'FLM PASSED: 200 distinct-fingerprint attempts from a trusted source created % issues (ceiling 50 in this test)', (select count(*) from public.system_issues);
end $$;

-- ================= many users, one error, through the real client boundary =================
do $$
declare
  v_users uuid[] := '{}';
  v_u uuid;
  v_k integer;
  v_j integer;
  v_acc integer := 0;
  v_res json;
  v_i public.system_issues;
  v_ev bigint;
begin
  perform pg_temp.t140_reset();
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';
  for v_k in 1..60 loop
    v_u := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (v_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't140-u' || v_k || '@test.local',
            jsonb_build_object('full_name', 'u' || v_k, 'phone', '05014' || lpad(v_k::text, 5, '0'), 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
    v_users := v_users || v_u;
  end loop;
  update public.profiles set approval_status = 'approved' where user_id = any (v_users);
  -- 60 users x 25 attempts (per-user quota is 20/h) = 1,500 attempts of ONE error through report_client_error
  foreach v_u in array v_users loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
    for v_j in 1..25 loop
      v_res := public.report_client_error('{"operation":"rpc/many_users","error_class":"PostgrestError","error_code":"500","message":"boom for everyone","platform":"ios","app_version":"1.0.0"}'::jsonb);
      if (v_res ->> 'accepted')::boolean then v_acc := v_acc + 1; end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  select * into v_i from public.system_issues where operation = 'rpc/many_users';
  select count(*) into v_ev from public.system_issue_events where issue_id = v_i.id;
  if (select count(*) from public.system_issues) <> 1 or v_i.occurrence_count <> 1000 or v_acc <> 1000 or v_ev <> 5 then
    raise exception 'FLU FAILED: issues=% occ=% accepted=% events=%', (select count(*) from public.system_issues), v_i.occurrence_count, v_acc, v_ev;
  end if;
  raise notice 'FLU PASSED: 60 users x 25 attempts (1,500) of one error => 1 issue, occurrence_count 1000 (breaker), 5 event rows, accepted=%; %', v_acc, pg_temp.t140_rows();
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
end $$;

-- ================= FAILURE ISOLATION =================
create function pg_temp.t140_biz(p_payload jsonb) returns text language plpgsql as $$
begin
  insert into t140_biz values (1);
  begin
    raise exception 'simulated business-side swallowed failure';
  exception when others then
    perform public._report_system_error('db', 'recurring_sessions', 'fn/biz', 'exception', 'P0001', sqlerrm, 'critical', '{}'::jsonb, p_payload::jsonb, null, 1, null);
  end;
  insert into t140_biz values (2);
  return 'done';
end $$;

do $$
declare
  v_res jsonb;
  v_j json;
  v_n bigint;
  v_p jsonb;
  v_big text := repeat('x', 100000);
  r record;
  v_out text;
begin
  perform pg_temp.t140_reset();

  -- I1: malformed payloads on every entry point never raise.
  foreach v_out in array array['null', '[]', '"just a string"', '123', 'true', '[1,2,3]', '{"operation": 5, "message": {"a": 1}, "severity": [1], "context": "x", "entities": 7}', '{"message": null, "stack": 5}'] loop
    v_p := v_out::jsonb;
    v_res := public._system_ingest('trusted', v_p, null);
    v_res := public._system_ingest('client', v_p, null);
    v_j := public.system_report_trusted(v_p);
    v_j := public.report_client_error(v_p);
    perform public._report_system_error('db', 'x', 'fn/x', null, null, null, 'not-a-severity', 'null'::jsonb, '[]'::jsonb, 'BAD KEY!', -5, null);
  end loop;
  v_res := public._system_ingest('trusted', null, null);
  v_res := public._system_ingest(null, '{}'::jsonb, null);
  v_res := public._system_ingest('wat', '{"operation":"fn/x"}'::jsonb, null);
  if v_res ->> 'reason' <> 'invalid_trust' then raise exception 'I1 FAILED: unknown trust level must be rejected'; end if;
  perform public._report_system_error(null, null, null);
  perform public._report_system_error(v_big, v_big, v_big, v_big, v_big, v_big, v_big, to_jsonb(v_big), to_jsonb(v_big), v_big, 2147483647, v_big);
  raise notice 'I1 PASSED: malformed / null / wrong-typed payloads on all entry points never raise';

  -- I2: oversized payloads are dropped before any write.
  v_n := (select count(*) from public.system_issues);
  v_res := public._system_ingest('trusted', jsonb_build_object('operation', 'fn/big', 'message', v_big), null);
  if v_res ->> 'reason' <> 'too_large' then raise exception 'I2 FAILED: trusted oversize => %', v_res; end if;
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';
  v_res := public._system_ingest('client', jsonb_build_object('operation', 'rpc/big', 'message', repeat('y', 20000)), gen_random_uuid());
  if v_res ->> 'reason' not in ('too_large') then raise exception 'I2 FAILED: client oversize => %', v_res; end if;
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
  if (select count(*) from public.system_issues where operation in ('fn/big', 'rpc/big')) <> 0 then raise exception 'I2 FAILED: an oversized payload was stored'; end if;
  -- within the limit but with huge fields: truncated, not rejected
  v_res := public._system_ingest('trusted', jsonb_build_object('operation', 'fn/bigfields', 'message', repeat('z ', 20000)), null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I2 FAILED: %', v_res; end if;
  raise notice 'I2 PASSED: payloads over the size cap are dropped (trusted 64KB / client 16KB) without writing; large fields inside the cap are truncated';

  -- I3: malformed configuration falls back to safe defaults instead of failing.
  update public.system_monitoring_config set value = '"a string"'::jsonb where key = 'limits';
  update public.system_monitoring_config set value = '[]'::jsonb where key = 'retention';
  update public.system_monitoring_config set value = '[1,2]'::jsonb where key = 'context_allowed_keys';
  update public.system_monitoring_config set value = '"yes"'::jsonb where key = 'ingest_enabled';
  update public.system_monitoring_config set value = '"true"'::jsonb where key = 'client_ingest_enabled';
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i3","message":"cfg","context":{"http_status":500,"phone":"0501234567"},"severity":"error"}'::jsonb, null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I3 FAILED: ingest with malformed config: %', v_res; end if;
  if (select e.context from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/i3') ? 'phone' then
    raise exception 'I3 FAILED: malformed allowlist config must fall back to the baked-in allowlist';
  end if;
  v_res := public._system_ingest('client', '{"operation":"rpc/i3","message":"x"}'::jsonb, gen_random_uuid());
  if v_res ->> 'reason' <> 'disabled' then raise exception 'I3 FAILED: a non-boolean client_ingest_enabled must fall back to disabled: %', v_res; end if;
  v_res := public._system_monitoring_maintenance();
  update public.system_monitoring_config set value = '{"breaker_per_hour": -1, "user_reports_per_hour": 1.5, "max_events_per_issue": "x", "events_per_issue_per_hour": 99999999999}'::jsonb where key = 'limits';
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i3b","message":"limits"}'::jsonb, null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I3 FAILED: bad numeric limits must fall back to defaults: %', v_res; end if;
  delete from public.system_monitoring_config where key = 'limits';
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i3c","message":"limits missing"}'::jsonb, null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I3 FAILED: a missing limits row must fall back to defaults'; end if;
  raise notice 'I3 PASSED: malformed or missing configuration (limits, retention, allowlist, switches) falls back to safe defaults';

  -- restore the seed values for the following tests
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'ingest_enabled';
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
  insert into public.system_monitoring_config (key, value) values ('limits', jsonb_build_object('breaker_per_hour', 1000, 'events_per_issue_per_hour', 5, 'max_events_per_issue', 50,
    'user_reports_per_hour', 20, 'user_new_fingerprints_per_hour', 5, 'client_new_issues_per_hour', 100, 'trusted_new_issues_per_hour', 500));
  update public.system_monitoring_config set value = (select jsonb_build_object('entities', jsonb_build_object('session_id', 'uuid'), 'context', jsonb_build_object('http_status', 'int', 'phase', 'enum'))) where key = 'context_allowed_keys';

  -- I4: malformed rule rows (constraints removed to simulate corruption) never break ingestion.
  for r in select conname from pg_constraint where conrelid = 'public.system_issue_rules'::regclass and contype = 'c' loop
    execute format('alter table public.system_issue_rules drop constraint %I', r.conname);
  end loop;
  insert into public.system_issue_rules (match_operation, action, set_subsystem, set_title, severity_floor, severity_cap, impact)
  values ('fn/i4*', 'classify', 'BAD SUBSYSTEM!', repeat('t', 5000), 'bogus', 'bogus2', 'bogus3');
  v_res := public._system_ingest('trusted', '{"source":"edge","subsystem":"docs","operation":"fn/i4/x","message":"rule","severity":"warning"}'::jsonb, null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I4 FAILED: ingest with a malformed rule: %', v_res; end if;
  if (select severity from public.system_issues where operation = 'fn/i4/x') <> 'warning'
     or (select subsystem from public.system_issues where operation = 'fn/i4/x') <> 'docs'
     or (select impact from public.system_issues where operation = 'fn/i4/x') is not null
     or char_length((select title from public.system_issues where operation = 'fn/i4/x')) > 160 then
    raise exception 'I4 FAILED: malformed rule values leaked into the issue: %', (select row_to_json(i) from public.system_issues i where operation = 'fn/i4/x');
  end if;
  v_n := public._system_reapply_rules();
  raise notice 'I4 PASSED: a rule row with invalid severities / subsystem / impact / title is neutralised (defaults apply; invalid values never reach issues)';

  -- I5: internal reporter failure never reaches the caller; the caller keeps its own work.
  create function pg_temp.t140_boom() returns trigger language plpgsql as $b$ begin raise exception 'simulated monitoring-table failure'; end $b$;
  create trigger t140_events_boom before insert on public.system_issue_events for each row execute function pg_temp.t140_boom();
  delete from t140_biz;
  if pg_temp.t140_biz('{"phase":"x"}'::jsonb) <> 'done' then raise exception 'I5 FAILED: the business function did not complete'; end if;
  if (select count(*) from t140_biz) <> 2 then raise exception 'I5 FAILED: business writes were lost'; end if;
  if exists (select 1 from public.system_issues where operation = 'fn/biz') then raise exception 'I5 FAILED: the failed report left a half-written issue (must roll back as a unit)'; end if;
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i5","message":"m"}'::jsonb, null);
  if v_res ->> 'reason' <> 'internal' or (v_res ->> 'accepted')::boolean is not false then raise exception 'I5 FAILED: %', v_res; end if;
  v_j := public.system_report_trusted('{"source":"edge","operation":"fn/i5","message":"m"}'::jsonb);
  if (v_j ->> 'ok')::boolean is not true or (v_j ->> 'accepted')::boolean is not false then raise exception 'I5 FAILED: trusted json %', v_j; end if;
  if current_setting('shira.monitoring_active', true) = 'on' then raise exception 'I5 FAILED: the re-entrancy flag stuck after a failure'; end if;
  drop trigger t140_events_boom on public.system_issue_events;
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i5","message":"m"}'::jsonb, null);
  if (v_res ->> 'accepted')::boolean is not true then raise exception 'I5 FAILED: ingestion did not recover after the failure: %', v_res; end if;
  raise notice 'I5 PASSED: an internal write failure is reduced to {accepted:false,internal}; the business function completes and keeps its writes; ingestion recovers';

  -- I6: monitoring disabled => nothing written, nothing raised.
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'ingest_enabled';
  v_n := (select count(*) from public.system_issues);
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i6","message":"m"}'::jsonb, null);
  if v_res ->> 'reason' <> 'disabled' or (select count(*) from public.system_issues) <> v_n then raise exception 'I6 FAILED'; end if;
  perform pg_temp.t140_biz('{}'::jsonb);
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'ingest_enabled';
  raise notice 'I6 PASSED: ingest_enabled=false turns every entry point into a no-op';

  -- I7: re-entrancy guard.
  perform set_config('shira.monitoring_active', 'on', true);
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i7","message":"m"}'::jsonb, null);
  if v_res ->> 'reason' <> 'reentrant' or exists (select 1 from public.system_issues where operation = 'fn/i7') then raise exception 'I7 FAILED: %', v_res; end if;
  perform set_config('shira.monitoring_active', 'off', true);
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i7","message":"m"}'::jsonb, null);
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i7","message":"m"}'::jsonb, null);
  if (select occurrence_count from public.system_issues where operation = 'fn/i7') <> 2 then raise exception 'I7 FAILED: sequential reports must both be accepted'; end if;
  raise notice 'I7 PASSED: a nested report is refused (no recursion); sequential reports in one transaction all work';

  -- I8: duplicate-key style race inside one transaction (second insert path) behaves.
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i8","message":"m"}'::jsonb, null);
  v_res := public._system_ingest('trusted', '{"source":"edge","operation":"fn/i8","message":"m"}'::jsonb, null);
  if (select count(*) from public.system_issues where operation = 'fn/i8') <> 1 then raise exception 'I8 FAILED'; end if;
  raise notice 'I8 PASSED: repeated first-creation attempts converge on one issue';

  raise notice 'ALL SYSTEM MONITORING FLOOD / FAILURE-ISOLATION TESTS PASSED';
end $$;

rollback;
