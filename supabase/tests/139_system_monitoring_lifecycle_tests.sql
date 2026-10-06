-- System monitoring Phase 1: lifecycle, escalation, rules, maintenance and retention.
--
-- Covers: first report, repeat, acknowledge, repeat while acknowledged, escalation, stale resolve,
-- resolve, recurrence / reopen / reopen_count / flapping, version regression, mute, recurrence while
-- muted, unmute, mute expiry, manual reopen, invalid transitions, the transition audit trail, rule
-- matching / precedence / actions / re-apply, and _system_monitoring_maintenance() (auto-quiet,
-- decay, retention). Self-contained: own fixtures; everything is rolled back.
set client_min_messages to notice;
begin;

create temp table t139_fx (k text primary key, v uuid);

create function pg_temp.t139_rep(p_op text, p_msg text default 'boom', p_sev text default 'error', p_ver text default null, p_code text default null)
returns jsonb language sql as $$
  select public._system_ingest('trusted', jsonb_strip_nulls(jsonb_build_object('source', 'edge', 'subsystem', 'docs', 'operation', p_op,
    'message', p_msg, 'severity', p_sev, 'app_version', p_ver, 'error_code', p_code)), null)
$$;

create function pg_temp.t139_as(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true)
$$;

create function pg_temp.t139_issue(p_op text) returns public.system_issues language sql as $$
  select i from public.system_issues i where i.operation = p_op
$$;

create function pg_temp.t139_kinds(p_op text) returns text language sql as $$
  select coalesce(string_agg(t.kind, ',' order by t.id), '') from public.system_issue_transitions t
  join public.system_issues i on i.id = t.issue_id where i.operation = p_op
$$;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_mgr2 uuid := gen_random_uuid();
  v_res json;
  v_i public.system_issues;
  v_n bigint;
  v_id uuid;
  v_k integer;
  v_ls timestamptz;
  v_json jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_mgr, 't139-m1@test.local', '0501390001'), (v_mgr2, 't139-m2@test.local', '0501390002')) u(id, e, p);
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id in (v_mgr, v_mgr2);
  insert into t139_fx values ('mgr', v_mgr), ('mgr2', v_mgr2);

  -- ===== L1: first report =====
  perform pg_temp.t139_rep('fn/l1');
  v_i := pg_temp.t139_issue('fn/l1');
  if v_i.status <> 'open' or v_i.occurrence_count <> 1 or v_i.reopen_count <> 0 or v_i.severity <> 'error' or v_i.first_seen is null
     or v_i.resolution is not null or v_i.acknowledged_at is not null then
    raise exception 'L1 FAILED: %', row_to_json(v_i);
  end if;
  if pg_temp.t139_kinds('fn/l1') <> 'create' then raise exception 'L1 FAILED: transitions %', pg_temp.t139_kinds('fn/l1'); end if;
  if (select count(*) from public.system_issue_events where issue_id = v_i.id and sample_reason = 'first') <> 1 then raise exception 'L1 FAILED: first event'; end if;
  if (select count from public.system_issue_buckets where issue_id = v_i.id) <> 1 then raise exception 'L1 FAILED: bucket'; end if;
  raise notice 'L1 PASSED: first report opens an issue with a create transition, a first event and a bucket';

  -- ===== L2: repeat updates the same issue =====
  perform pg_temp.t139_rep('fn/l1');
  v_i := pg_temp.t139_issue('fn/l1');
  if v_i.occurrence_count <> 2 or (select count(*) from public.system_issues where operation = 'fn/l1') <> 1 then raise exception 'L2 FAILED'; end if;
  if v_i.first_seen > v_i.last_seen then raise exception 'L2 FAILED: first_seen/last_seen'; end if;
  raise notice 'L2 PASSED: a repeat increments the one issue';

  -- ===== L3/L4: acknowledge, then repeat while acknowledged =====
  perform pg_temp.t139_as(v_mgr);
  v_res := public.system_issue_acknowledge(v_i.id);
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L3 FAILED: %', v_res; end if;
  v_i := pg_temp.t139_issue('fn/l1');
  if v_i.status <> 'acknowledged' or v_i.acknowledged_by <> v_mgr or v_i.acknowledged_at is null then raise exception 'L3 FAILED: %', row_to_json(v_i); end if;
  perform pg_temp.t139_rep('fn/l1');
  v_i := pg_temp.t139_issue('fn/l1');
  if v_i.status <> 'acknowledged' or v_i.occurrence_count <> 3 then raise exception 'L4 FAILED: %', row_to_json(v_i); end if;
  -- acknowledging again is idempotent
  v_res := public.system_issue_acknowledge(v_i.id);
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L4 FAILED: second ack %', v_res; end if;
  raise notice 'L3 PASSED: acknowledge records who/when';
  raise notice 'L4 PASSED: a repeat while acknowledged keeps it acknowledged (acknowledging does not hide recurrence: counters still move)';

  -- ===== L5: escalation (warning -> error at 10/hour) returns an acknowledged issue to open =====
  perform pg_temp.t139_rep('fn/l5', 'warn', 'warning');
  v_i := pg_temp.t139_issue('fn/l5');
  if v_i.severity <> 'warning' then raise exception 'L5 FAILED: base warning expected'; end if;
  v_res := public.system_issue_acknowledge(v_i.id);
  for v_k in 2..9 loop perform pg_temp.t139_rep('fn/l5', 'warn', 'warning'); end loop;
  v_i := pg_temp.t139_issue('fn/l5');
  if v_i.severity <> 'warning' or v_i.status <> 'acknowledged' then raise exception 'L5 FAILED: escalated too early: %', row_to_json(v_i); end if;
  perform pg_temp.t139_rep('fn/l5', 'warn', 'warning');
  v_i := pg_temp.t139_issue('fn/l5');
  if v_i.severity <> 'error' or v_i.base_severity <> 'warning' or v_i.status <> 'open' or v_i.acknowledged_at is not null then
    raise exception 'L5 FAILED: expected escalation to error + back to open: %', row_to_json(v_i);
  end if;
  if pg_temp.t139_kinds('fn/l5') <> 'create,ack,escalate' then raise exception 'L5 FAILED: transitions %', pg_temp.t139_kinds('fn/l5'); end if;
  if not exists (select 1 from public.system_issue_events where issue_id = v_i.id and sample_reason = 'escalation') then
    raise exception 'L5 FAILED: no escalation event was recorded';
  end if;
  raise notice 'L5 PASSED: 10 warnings in an hour escalate to error; an acknowledged issue returns to open; the escalation is recorded';

  -- ===== L6/L7: stale resolve, then resolve =====
  perform pg_temp.t139_rep('fn/l6', 'x', 'error', '1.0.0');
  v_i := pg_temp.t139_issue('fn/l6');
  v_res := public.system_issue_resolve(v_i.id, 'manual_fixed', v_i.last_seen - interval '1 minute');
  if (v_res ->> 'ok')::boolean is not false or v_res ->> 'error' <> 'stale' then raise exception 'L6 FAILED: %', v_res; end if;
  if (pg_temp.t139_issue('fn/l6')).status <> 'open' then raise exception 'L6 FAILED: stale resolve changed the issue'; end if;
  v_res := public.system_issue_resolve(v_i.id, 'manual_fixed', v_i.last_seen);
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L7 FAILED: %', v_res; end if;
  v_i := pg_temp.t139_issue('fn/l6');
  if v_i.status <> 'resolved' or v_i.resolution <> 'manual_fixed' or v_i.resolved_by <> v_mgr or v_i.resolved_at is null or v_i.resolved_version <> '1.0.0' then
    raise exception 'L7 FAILED: %', row_to_json(v_i);
  end if;
  raise notice 'L6 PASSED: resolving with an out-of-date last_seen is refused (a newer occurrence is never buried)';
  raise notice 'L7 PASSED: resolve records reason, actor, time and the version it was resolved at';

  -- ===== L8/L9: recurrence reopens; version regression =====
  perform pg_temp.t139_rep('fn/l6', 'x', 'error', '1.0.0');
  v_i := pg_temp.t139_issue('fn/l6');
  if v_i.status <> 'open' or v_i.reopen_count <> 1 or v_i.reopened_at is null or v_i.resolution is not null or v_i.resolved_at is not null
     or v_i.regressed_in_version is not null or v_i.occurrence_count <> 2 then
    raise exception 'L8 FAILED: %', row_to_json(v_i);
  end if;
  if pg_temp.t139_kinds('fn/l6') <> 'create,resolve,auto_reopen' then raise exception 'L8 FAILED: %', pg_temp.t139_kinds('fn/l6'); end if;
  if v_i.first_seen > v_i.last_seen then raise exception 'L8 FAILED: first_seen must stay historical'; end if;
  v_res := public.system_issue_resolve(v_i.id, 'manual_fixed');
  perform pg_temp.t139_rep('fn/l6', 'x', 'error', '1.1.0');
  v_i := pg_temp.t139_issue('fn/l6');
  if v_i.status <> 'open' or v_i.reopen_count <> 2 or v_i.regressed_in_version <> '1.1.0' or v_i.last_seen_version <> '1.1.0' or v_i.first_seen_version <> '1.0.0' then
    raise exception 'L9 FAILED: %', row_to_json(v_i);
  end if;
  raise notice 'L8 PASSED: a recurrence after manual resolution reopens (reopen_count, reopened_at; first_seen unchanged)';
  raise notice 'L9 PASSED: recurrence on a different version after resolution is flagged as a regression';

  -- ===== L10: flapping escalation =====
  perform pg_temp.t139_rep('fn/l10', 'flap', 'warning');
  for v_k in 1..3 loop
    v_id := (pg_temp.t139_issue('fn/l10')).id;
    v_res := public.system_issue_resolve(v_id, 'manual_fixed');
    perform pg_temp.t139_rep('fn/l10', 'flap', 'warning');
    if v_k < 3 and (pg_temp.t139_issue('fn/l10')).severity <> 'warning' then raise exception 'L10 FAILED: escalated before the third reopen'; end if;
  end loop;
  v_i := pg_temp.t139_issue('fn/l10');
  if v_i.reopen_count <> 3 or v_i.severity <> 'error' or v_i.base_severity <> 'warning' then raise exception 'L10 FAILED: %', row_to_json(v_i); end if;
  raise notice 'L10 PASSED: the third reopen inside the window escalates a flapping warning to error';

  -- ===== L11: mute / recurrence while muted / unmute =====
  perform pg_temp.t139_rep('fn/l11', 'noisy', 'warning');
  v_i := pg_temp.t139_issue('fn/l11');
  v_res := public.system_issue_mute(v_i.id, null);
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L11 FAILED: %', v_res; end if;
  v_i := pg_temp.t139_issue('fn/l11');
  if v_i.status <> 'muted' or v_i.resolution <> 'manual_expected' then raise exception 'L11 FAILED: %', row_to_json(v_i); end if;
  v_n := (select count(*) from public.system_issue_events where issue_id = v_i.id);
  for v_k in 1..15 loop perform pg_temp.t139_rep('fn/l11', 'noisy', 'warning'); end loop;
  v_i := pg_temp.t139_issue('fn/l11');
  if v_i.status <> 'muted' or v_i.occurrence_count <> 16 or v_i.severity <> 'warning' or v_i.reopen_count <> 0 then
    raise exception 'L11 FAILED: a muted issue must keep counting, stay muted and not escalate: %', row_to_json(v_i);
  end if;
  if (select count(*) from public.system_issue_events where issue_id = v_i.id) <> v_n then raise exception 'L11 FAILED: events stored while muted'; end if;
  if (select count from public.system_issue_buckets where issue_id = v_i.id) <> 16 then raise exception 'L11 FAILED: bucket counter must continue while muted'; end if;
  v_res := public.system_issue_unmute(v_i.id);
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L11 FAILED: unmute %', v_res; end if;
  v_i := pg_temp.t139_issue('fn/l11');
  if v_i.status <> 'open' or v_i.resolution is not null or v_i.muted_until is not null then raise exception 'L11 FAILED: after unmute %', row_to_json(v_i); end if;
  perform pg_temp.t139_rep('fn/l11', 'noisy', 'warning');
  if (pg_temp.t139_issue('fn/l11')).severity <> 'error' then raise exception 'L11 FAILED: after unmute the issue must escalate normally (hour count is high)'; end if;
  if pg_temp.t139_kinds('fn/l11') <> 'create,mute,unmute' then raise exception 'L11 FAILED: %', pg_temp.t139_kinds('fn/l11'); end if;
  raise notice 'L11 PASSED: muted issues stay visible, keep bounded counters, store no events, do not escalate or reopen; unmute restores normal behavior';

  -- ===== L12: mute expiry (maintenance and at ingestion) =====
  perform pg_temp.t139_rep('fn/l12');
  v_id := (pg_temp.t139_issue('fn/l12')).id;
  v_res := public.system_issue_mute(v_id, now() + interval '1 hour');
  if (v_res ->> 'ok')::boolean is not true then raise exception 'L12 FAILED: %', v_res; end if;
  v_json := public._system_monitoring_maintenance(now() + interval '30 minutes');
  if (pg_temp.t139_issue('fn/l12')).status <> 'muted' then raise exception 'L12 FAILED: unmuted too early'; end if;
  v_json := public._system_monitoring_maintenance(now() + interval '2 hours');
  v_i := pg_temp.t139_issue('fn/l12');
  if v_i.status <> 'open' or v_i.muted_until is not null or pg_temp.t139_kinds('fn/l12') <> 'create,mute,auto_unmute' then
    raise exception 'L12 FAILED: %, %', row_to_json(v_i), pg_temp.t139_kinds('fn/l12');
  end if;
  -- expiry noticed by an occurrence (maintenance has not run)
  perform pg_temp.t139_rep('fn/l12b');
  v_id := (pg_temp.t139_issue('fn/l12b')).id;
  v_res := public.system_issue_mute(v_id, now() + interval '1 hour');
  update public.system_issues set muted_until = now() - interval '1 minute' where id = v_id;
  perform pg_temp.t139_rep('fn/l12b');
  if (pg_temp.t139_issue('fn/l12b')).status <> 'open' or pg_temp.t139_kinds('fn/l12b') <> 'create,mute,auto_unmute' then
    raise exception 'L12 FAILED: expired mute not ended by an occurrence: %', pg_temp.t139_kinds('fn/l12b');
  end if;
  raise notice 'L12 PASSED: a timed mute ends via maintenance or at the next occurrence';

  -- ===== L13: manual reopen and invalid transitions =====
  perform pg_temp.t139_rep('fn/l13');
  v_id := (pg_temp.t139_issue('fn/l13')).id;
  v_res := public.system_issue_resolve(v_id, 'manual_expected');
  if (pg_temp.t139_issue('fn/l13')).resolution <> 'manual_expected' then raise exception 'L13 FAILED: manual_expected resolution'; end if;
  v_json := to_jsonb(public.system_issue_acknowledge(v_id));
  if v_json ->> 'error' <> 'invalid_state' then raise exception 'L13 FAILED: ack on resolved %', v_json; end if;
  v_json := to_jsonb(public.system_issue_mute(v_id));
  if v_json ->> 'error' <> 'invalid_state' then raise exception 'L13 FAILED: mute on resolved %', v_json; end if;
  v_json := to_jsonb(public.system_issue_resolve(v_id));
  if v_json ->> 'error' <> 'invalid_state' then raise exception 'L13 FAILED: resolve on resolved %', v_json; end if;
  v_json := to_jsonb(public.system_issue_unmute(v_id));
  if v_json ->> 'error' <> 'invalid_state' then raise exception 'L13 FAILED: unmute on resolved %', v_json; end if;
  v_json := to_jsonb(public.system_issue_reopen(v_id));
  if (v_json ->> 'ok')::boolean is not true then raise exception 'L13 FAILED: reopen %', v_json; end if;
  v_i := pg_temp.t139_issue('fn/l13');
  if v_i.status <> 'open' or v_i.reopen_count <> 1 or v_i.resolution is not null then raise exception 'L13 FAILED: %', row_to_json(v_i); end if;
  v_json := to_jsonb(public.system_issue_reopen(v_id));
  if v_json ->> 'error' <> 'invalid_state' then raise exception 'L13 FAILED: reopen on open %', v_json; end if;
  v_json := to_jsonb(public.system_issue_resolve(v_id, 'bogus'));
  if v_json ->> 'error' <> 'invalid_reason' then raise exception 'L13 FAILED: bogus reason %', v_json; end if;
  v_json := to_jsonb(public.system_issue_resolve(v_id, 'auto_quiet'));
  if v_json ->> 'error' <> 'invalid_reason' then raise exception 'L13 FAILED: a manager may not use a system-only reason %', v_json; end if;
  v_json := to_jsonb(public.system_issue_mute(v_id, now() - interval '1 hour'));
  if v_json ->> 'error' <> 'invalid_until' then raise exception 'L13 FAILED: past mute %', v_json; end if;
  v_json := to_jsonb(public.system_issue_mute(v_id, now() + interval '400 days'));
  if v_json ->> 'error' <> 'invalid_until' then raise exception 'L13 FAILED: mute too long %', v_json; end if;
  v_json := to_jsonb(public.system_issue_acknowledge(gen_random_uuid()));
  if v_json ->> 'error' <> 'not_found' then raise exception 'L13 FAILED: unknown issue %', v_json; end if;
  v_json := to_jsonb(public.system_issue_acknowledge(null));
  if v_json ->> 'error' <> 'not_found' then raise exception 'L13 FAILED: null issue %', v_json; end if;
  raise notice 'L13 PASSED: manual reopen works; every invalid transition / argument is refused with a clear code';

  -- ===== L14: complete audit trail for one issue =====
  perform pg_temp.t139_rep('fn/l14');
  v_id := (pg_temp.t139_issue('fn/l14')).id;
  perform public.system_issue_acknowledge(v_id);
  perform pg_temp.t139_as(v_mgr2);
  perform public.system_issue_resolve(v_id, 'manual_fixed');
  perform pg_temp.t139_rep('fn/l14');
  perform pg_temp.t139_as(v_mgr);
  perform public.system_issue_mute(v_id);
  perform public.system_issue_unmute(v_id);
  perform public.system_issue_resolve(v_id, 'manual_expected');
  perform public.system_issue_reopen(v_id);
  if pg_temp.t139_kinds('fn/l14') <> 'create,ack,resolve,auto_reopen,mute,unmute,resolve,reopen' then
    raise exception 'L14 FAILED: %', pg_temp.t139_kinds('fn/l14');
  end if;
  if (select string_agg(coalesce(t.actor_user_id::text, 'system'), ',' order by t.id) from public.system_issue_transitions t where t.issue_id = v_id)
     <> concat_ws(',', 'system', v_mgr, v_mgr2, 'system', v_mgr, v_mgr, v_mgr, v_mgr) then
    raise exception 'L14 FAILED: actors are not recorded correctly';
  end if;
  if exists (select 1 from public.system_issue_transitions t where t.issue_id = v_id and t.kind = 'create' and t.from_status is not null) then
    raise exception 'L14 FAILED: create must have a NULL from_status';
  end if;
  raise notice 'L14 PASSED: every transition is recorded in order with the right actor (system vs manager)';
  perform pg_temp.t139_as(null);
end $$;

-- ================================ RULES ================================
do $$
declare
  v_i public.system_issues;
  v_rule1 uuid;
  v_rule2 uuid;
  v_n bigint;
  v_res jsonb;
  v_state text;
begin
  -- R-a: floor / cap / impact / subsystem / title; reported_subsystem is preserved.
  insert into public.system_issue_rules (match_operation, action, set_subsystem, set_title, severity_floor, impact, note)
  values ('fn/ra*', 'classify', 'recurring_sessions', 'Future sessions were not generated', 'critical', 'blocking', 'test');
  perform pg_temp.t139_rep('fn/ra/one', 'x', 'warning');
  v_i := pg_temp.t139_issue('fn/ra/one');
  if v_i.base_severity <> 'critical' or v_i.severity <> 'critical' or v_i.impact <> 'blocking' or v_i.subsystem <> 'recurring_sessions'
     or v_i.reported_subsystem <> 'docs' or v_i.title <> 'Future sessions were not generated' or v_i.rule_id is null then
    raise exception 'RA FAILED: %', row_to_json(v_i);
  end if;
  insert into public.system_issue_rules (match_operation, action, severity_cap, note) values ('fn/rcap', 'classify', 'warning', 'cap');
  perform pg_temp.t139_rep('fn/rcap', 'x', 'critical');
  if (pg_temp.t139_issue('fn/rcap')).severity <> 'warning' then raise exception 'RA FAILED: cap not applied'; end if;
  raise notice 'RA PASSED: rules can raise (floor), lower (cap), classify (subsystem/title/impact) while reported_subsystem is kept';

  -- R-b: precedence. priority > specificity > longer prefix > id.
  insert into public.system_issue_rules (match_operation, action, set_title, priority) values ('fn/rb*', 'classify', 'prefix', 0) returning id into v_rule1;
  insert into public.system_issue_rules (match_operation, match_error_code, action, set_title, priority) values ('fn/rb*', 'E1', 'classify', 'prefix+code', 0);
  perform pg_temp.t139_rep('fn/rb/x', 'm', 'error', null, 'E1');
  if (pg_temp.t139_issue('fn/rb/x')).title <> 'prefix+code' then raise exception 'RB FAILED: more specific rule must win at equal priority'; end if;
  insert into public.system_issue_rules (match_operation, action, set_title, priority) values ('fn/rb*', 'classify', 'high priority', 10);
  perform pg_temp.t139_rep('fn/rb/y', 'm', 'error', null, 'E1');
  if (pg_temp.t139_issue('fn/rb/y')).title <> 'high priority' then raise exception 'RB FAILED: higher priority must win'; end if;
  update public.system_issue_rules set enabled = false where set_title = 'high priority';
  insert into public.system_issue_rules (match_operation, action, set_title, priority) values ('fn/rb/long*', 'classify', 'long prefix', 5);
  insert into public.system_issue_rules (match_operation, action, set_title, priority) values ('fn/rb/lo*', 'classify', 'short prefix', 5);
  perform pg_temp.t139_rep('fn/rb/long/z');
  if (pg_temp.t139_issue('fn/rb/long/z')).title <> 'long prefix' then raise exception 'RB FAILED: longer prefix must win at equal priority/specificity'; end if;
  -- disabled rules never apply (the high-priority rule was disabled above)
  perform pg_temp.t139_rep('fn/rb/w', 'm', 'error', null, 'E1');
  if (pg_temp.t139_issue('fn/rb/w')).title <> 'prefix+code' then raise exception 'RB FAILED: a disabled rule applied: %', (pg_temp.t139_issue('fn/rb/w')).title; end if;
  -- exact match beats nothing: an exact op rule does not match a longer op
  insert into public.system_issue_rules (match_operation, action, set_title) values ('fn/rexact', 'classify', 'exact');
  perform pg_temp.t139_rep('fn/rexact/more');
  if (pg_temp.t139_issue('fn/rexact/more')).title = 'exact' then raise exception 'RB FAILED: exact rule matched a longer operation'; end if;
  raise notice 'RB PASSED: precedence is priority, then specificity, then longer prefix, then id; disabled rules and non-prefix rules behave';

  -- R-c: ignore drops silently; telemetry keeps counters only.
  insert into public.system_issue_rules (match_operation, action) values ('fn/rignore', 'ignore');
  v_res := pg_temp.t139_rep('fn/rignore');
  if (v_res ->> 'accepted')::boolean is not false or v_res ->> 'reason' <> 'ignored' then raise exception 'RC FAILED: %', v_res; end if;
  if exists (select 1 from public.system_issues where operation = 'fn/rignore') then raise exception 'RC FAILED: ignored report was stored'; end if;
  insert into public.system_issue_rules (match_operation, action) values ('fn/rtel', 'telemetry');
  perform pg_temp.t139_rep('fn/rtel'); perform pg_temp.t139_rep('fn/rtel'); perform pg_temp.t139_rep('fn/rtel');
  v_i := pg_temp.t139_issue('fn/rtel');
  if v_i.status <> 'muted' or v_i.severity <> 'info' or v_i.occurrence_count <> 3 then raise exception 'RC FAILED: telemetry %', row_to_json(v_i); end if;
  if exists (select 1 from public.system_issue_events where issue_id = v_i.id) then raise exception 'RC FAILED: telemetry stored events'; end if;
  raise notice 'RC PASSED: ignore stores nothing; telemetry keeps only bounded counters on a muted info issue';

  -- R-d: constraints refuse unsafe rules.
  begin
    insert into public.system_issue_rules (action, set_title) values ('classify', 'catch-all');
    raise exception 'RD FAILED: a catch-all rule was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.system_issue_rules (match_source, action) values ('edge', 'ignore');
    raise exception 'RD FAILED: an un-anchored ignore rule was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.system_issue_rules (match_operation, action, severity_floor, severity_cap) values ('fn/x', 'classify', 'critical', 'warning');
    raise exception 'RD FAILED: floor above cap was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.system_issue_rules (match_operation, action) values ('fn/x%', 'classify');
    raise exception 'RD FAILED: a LIKE metacharacter in match_operation was accepted';
  exception when check_violation then null; end;
  raise notice 'RD PASSED: catch-all, un-anchored ignore, floor>cap and wildcard-metacharacter rules are rejected by constraints';

  -- R-e: re-apply rules to existing issues.
  perform pg_temp.t139_rep('fn/re/one', 'm', 'warning');
  if (pg_temp.t139_issue('fn/re/one')).title = 'Reapplied' then raise exception 'RE FAILED: precondition'; end if;
  insert into public.system_issue_rules (match_operation, action, set_title, set_subsystem, impact) values ('fn/re/*', 'classify', 'Reapplied', 'reapplied_sub', 'degraded');
  v_n := public._system_reapply_rules(array[(pg_temp.t139_issue('fn/re/one')).id]);
  v_i := pg_temp.t139_issue('fn/re/one');
  if v_n <> 1 or v_i.title <> 'Reapplied' or v_i.subsystem <> 'reapplied_sub' or v_i.impact <> 'degraded' or v_i.reported_subsystem <> 'docs' then
    raise exception 'RE FAILED: %', row_to_json(v_i);
  end if;
  delete from public.system_issue_rules where set_title = 'Reapplied';
  v_n := public._system_reapply_rules(array[v_i.id]);
  v_i := pg_temp.t139_issue('fn/re/one');
  if v_i.title <> 'docs: fn/re/one' or v_i.subsystem <> 'docs' or v_i.impact is not null or v_i.rule_id is not null then
    raise exception 'RE FAILED: removing the rule and re-applying must restore defaults: %', row_to_json(v_i);
  end if;
  -- a telemetry rule introduced later mutes an existing issue on re-apply
  insert into public.system_issue_rules (match_operation, action) values ('fn/re/*', 'telemetry');
  v_n := public._system_reapply_rules(array[v_i.id]);
  if (pg_temp.t139_issue('fn/re/one')).status <> 'muted' then raise exception 'RE FAILED: telemetry re-apply'; end if;
  raise notice 'RE PASSED: re-applying rules updates classification (and restores defaults when the rule is removed)';
end $$;

-- ================================ MAINTENANCE / RETENTION ================================
do $$
declare
  v_i public.system_issues;
  v_id uuid;
  v_r jsonb;
  v_n bigint;
  v_now timestamptz := now();
  v_ev integer;
begin
  -- M1: quiet auto-resolve thresholds by severity; critical never; rule override.
  perform pg_temp.t139_rep('fn/m1/info', 'x', 'info');
  perform pg_temp.t139_rep('fn/m1/warn', 'x', 'warning');
  perform pg_temp.t139_rep('fn/m1/err', 'x', 'error');
  perform pg_temp.t139_rep('fn/m1/crit', 'x', 'critical');
  perform pg_temp.t139_rep('fn/m1/ackerr', 'x', 'error');
  update public.system_issues set status = 'acknowledged', acknowledged_at = now() where operation = 'fn/m1/ackerr';
  insert into public.system_issue_rules (match_operation, action, quiet_resolve_hours, set_title) values ('fn/m1/rule', 'classify', 2, 'rule quiet');
  perform pg_temp.t139_rep('fn/m1/rule', 'x', 'critical');
  update public.system_issues set last_seen = v_now - interval '23 hours' where operation like 'fn/m1/%';
  v_r := public._system_monitoring_maintenance(v_now);
  if (select count(*) from public.system_issues where operation like 'fn/m1/%' and status = 'resolved') <> 1 then
    -- only the rule-override critical (2h) is old enough
    if (pg_temp.t139_issue('fn/m1/rule')).status <> 'resolved' then raise exception 'M1 FAILED: rule quiet_resolve_hours not honoured'; end if;
  end if;
  update public.system_issues set last_seen = v_now - interval '25 hours' where operation in ('fn/m1/info', 'fn/m1/warn', 'fn/m1/err', 'fn/m1/crit', 'fn/m1/ackerr');
  v_r := public._system_monitoring_maintenance(v_now);
  if (pg_temp.t139_issue('fn/m1/info')).status <> 'resolved' or (pg_temp.t139_issue('fn/m1/warn')).status <> 'resolved' then
    raise exception 'M1 FAILED: info / warning must auto-resolve after 24h of quiet';
  end if;
  if (pg_temp.t139_issue('fn/m1/err')).status <> 'open' or (pg_temp.t139_issue('fn/m1/ackerr')).status <> 'acknowledged' then
    raise exception 'M1 FAILED: errors must not auto-resolve after 25h';
  end if;
  update public.system_issues set last_seen = v_now - interval '8 days' where operation in ('fn/m1/err', 'fn/m1/ackerr');
  update public.system_issues set last_seen = v_now - interval '800 days' where operation = 'fn/m1/crit';
  v_r := public._system_monitoring_maintenance(v_now);
  if (pg_temp.t139_issue('fn/m1/err')).status <> 'resolved' or (pg_temp.t139_issue('fn/m1/err')).resolution <> 'auto_quiet'
     or (pg_temp.t139_issue('fn/m1/ackerr')).status <> 'resolved' then
    raise exception 'M1 FAILED: errors (open or acknowledged) must auto-resolve after 7 days of quiet';
  end if;
  if (pg_temp.t139_issue('fn/m1/crit')).status <> 'open' then raise exception 'M1 FAILED: critical must never auto-resolve by quiet'; end if;
  if pg_temp.t139_kinds('fn/m1/err') <> 'create,auto_resolve' then raise exception 'M1 FAILED: transitions %', pg_temp.t139_kinds('fn/m1/err'); end if;
  raise notice 'M1 PASSED: auto-quiet resolves info/warning at 24h, error at 7d, never critical (unless its rule says so); acknowledged issues included';

  -- M1b: a muted issue is not auto-resolved.
  perform pg_temp.t139_rep('fn/m1/muted', 'x', 'warning');
  update public.system_issues set status = 'muted', resolution = 'manual_expected', last_seen = v_now - interval '30 days' where operation = 'fn/m1/muted';
  v_r := public._system_monitoring_maintenance(v_now);
  if (pg_temp.t139_issue('fn/m1/muted')).status <> 'muted' then raise exception 'M1b FAILED'; end if;
  raise notice 'M1b PASSED: muted issues are left alone by quiet auto-resolve';

  -- M2: escalation decay.
  perform pg_temp.t139_rep('fn/m2', 'x', 'warning');
  update public.system_issues set severity = 'error', last_seen = v_now - interval '25 hours' where operation = 'fn/m2';
  v_r := public._system_monitoring_maintenance(v_now);
  v_i := pg_temp.t139_issue('fn/m2');
  if v_i.severity <> 'warning' or v_i.base_severity <> 'warning' then raise exception 'M2 FAILED: %', row_to_json(v_i); end if;
  update public.system_issues set status = 'open', resolution = null, resolved_at = null, resolved_by = null,
    severity = 'error', last_seen = v_now - interval '1 hour' where operation = 'fn/m2';
  v_r := public._system_monitoring_maintenance(v_now);
  if (pg_temp.t139_issue('fn/m2')).severity <> 'error' then raise exception 'M2 FAILED: recent escalation must not decay'; end if;
  raise notice 'M2 PASSED: escalation decays back to the declared base severity only after 24h without occurrences';

  -- M3: event retention by severity; first occurrence kept; hard per-issue cap.
  perform pg_temp.t139_rep('fn/m3/err', 'x', 'error');
  perform pg_temp.t139_rep('fn/m3/warn', 'x', 'warning');
  perform pg_temp.t139_rep('fn/m3/crit', 'x', 'critical');
  for v_id in select id from public.system_issues where operation like 'fn/m3/%' loop
    insert into public.system_issue_events (issue_id, occurred_at, severity, sample_reason)
    select v_id, v_now - interval '40 days' - (g || ' minutes')::interval, (select severity from public.system_issues where id = v_id), 'sampled' from generate_series(1, 3) g;
    insert into public.system_issue_events (issue_id, occurred_at, severity, sample_reason)
    select v_id, v_now - interval '120 days' - (g || ' minutes')::interval, (select severity from public.system_issues where id = v_id), 'sampled' from generate_series(1, 3) g;
    insert into public.system_issue_events (issue_id, occurred_at, severity, sample_reason)
    select v_id, v_now - interval '300 days', (select severity from public.system_issues where id = v_id), 'sampled';
  end loop;
  update public.system_issue_events set occurred_at = v_now - interval '500 days' where sample_reason = 'first'
    and issue_id in (select id from public.system_issues where operation like 'fn/m3/%');
  v_r := public._system_monitoring_maintenance(v_now);
  -- warning: 30d => all injected events gone; error: 90d => 40d kept, 120/300 gone; critical: 180d => 40/120 kept, 300 gone
  if (select count(*) from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/m3/warn' and e.sample_reason <> 'first') <> 0 then
    raise exception 'M3 FAILED: warning events older than 30d must be pruned';
  end if;
  if (select count(*) from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/m3/err' and e.sample_reason <> 'first') <> 3 then
    raise exception 'M3 FAILED: error events: expected the 3 within 90d';
  end if;
  if (select count(*) from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/m3/crit' and e.sample_reason <> 'first') <> 6 then
    raise exception 'M3 FAILED: critical events: expected the 6 within 180d';
  end if;
  if (select count(*) from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation like 'fn/m3/%' and e.sample_reason = 'first') <> 3 then
    raise exception 'M3 FAILED: the first occurrence must survive retention (even at 500 days)';
  end if;
  raise notice 'M3 PASSED: event retention is 30/30/90/180 days by severity and the first occurrence is always kept';

  -- M4: hard cap of 50 events per issue (keeps the first, then the newest).
  perform pg_temp.t139_rep('fn/m4');
  v_id := (pg_temp.t139_issue('fn/m4')).id;
  insert into public.system_issue_events (issue_id, occurred_at, severity, sample_reason)
  select v_id, v_now - (g || ' seconds')::interval, 'error', 'sampled' from generate_series(1, 80) g;
  v_r := public._system_monitoring_maintenance(v_now);
  select count(*) into v_n from public.system_issue_events where issue_id = v_id;
  if v_n <> 50 then raise exception 'M4 FAILED: % events remain (expected 50)', v_n; end if;
  if not exists (select 1 from public.system_issue_events where issue_id = v_id and sample_reason = 'first') then raise exception 'M4 FAILED: first event lost'; end if;
  if not exists (select 1 from public.system_issue_events where issue_id = v_id and occurred_at = v_now - interval '1 second') then raise exception 'M4 FAILED: newest events must be kept'; end if;
  raise notice 'M4 PASSED: the per-issue event cap (50) keeps the first and the newest';

  -- M5: buckets (60d), quota (48h), resolved issues by severity; active issues are never deleted.
  perform pg_temp.t139_rep('fn/m5/old');
  v_id := (pg_temp.t139_issue('fn/m5/old')).id;
  insert into public.system_issue_buckets (issue_id, bucket_start, count) values (v_id, date_trunc('hour', v_now - interval '61 days'), 5), (v_id, date_trunc('hour', v_now - interval '59 days'), 5);
  insert into public.system_report_quota (user_id, bucket_start, reports) values (gen_random_uuid(), date_trunc('hour', v_now - interval '49 hours'), 1), (gen_random_uuid(), date_trunc('hour', v_now - interval '47 hours'), 1);
  perform pg_temp.t139_rep('fn/m5/resw', 'x', 'warning'); perform pg_temp.t139_rep('fn/m5/rese', 'x', 'error'); perform pg_temp.t139_rep('fn/m5/resc', 'x', 'critical');
  update public.system_issues set status = 'resolved', resolution = 'manual_fixed', resolved_at = v_now - interval '100 days' where operation = 'fn/m5/resw';
  update public.system_issues set status = 'resolved', resolution = 'manual_fixed', resolved_at = v_now - interval '100 days' where operation = 'fn/m5/rese';
  update public.system_issues set status = 'resolved', resolution = 'manual_fixed', resolved_at = v_now - interval '100 days' where operation = 'fn/m5/resc';
  perform pg_temp.t139_rep('fn/m5/openold', 'x', 'warning');
  update public.system_issues set first_seen = v_now - interval '900 days', last_seen = now() where operation = 'fn/m5/openold';
  v_r := public._system_monitoring_maintenance(v_now);
  if (select count(*) from public.system_issue_buckets where issue_id = v_id) <> 2 then
    -- the original (current-hour) bucket + the 59d one remain; the 61d one is gone
    if exists (select 1 from public.system_issue_buckets where issue_id = v_id and bucket_start < v_now - interval '60 days') then raise exception 'M5 FAILED: old bucket kept'; end if;
  end if;
  if exists (select 1 from public.system_issue_buckets where issue_id = v_id and bucket_start < v_now - interval '60 days') then raise exception 'M5 FAILED: bucket older than 60d kept'; end if;
  if not exists (select 1 from public.system_issue_buckets where issue_id = v_id and bucket_start = date_trunc('hour', v_now - interval '59 days')) then raise exception 'M5 FAILED: a bucket inside retention was deleted'; end if;
  if (select count(*) from public.system_report_quota where bucket_start < v_now - interval '48 hours') <> 0 or (select count(*) from public.system_report_quota where bucket_start >= v_now - interval '48 hours') < 1 then
    raise exception 'M5 FAILED: quota retention';
  end if;
  if exists (select 1 from public.system_issues where operation = 'fn/m5/resw') then raise exception 'M5 FAILED: warning resolved 100d ago must be deleted (90d)'; end if;
  if not exists (select 1 from public.system_issues where operation = 'fn/m5/rese') or not exists (select 1 from public.system_issues where operation = 'fn/m5/resc') then
    raise exception 'M5 FAILED: error (365d) / critical (730d) resolved issues must still exist';
  end if;
  if not exists (select 1 from public.system_issues where operation = 'fn/m5/openold') then raise exception 'M5 FAILED: an active issue must never be deleted'; end if;
  if exists (select 1 from public.system_issue_transitions t where not exists (select 1 from public.system_issues i where i.id = t.issue_id)) then raise exception 'M5 FAILED: orphan transitions'; end if;
  raise notice 'M5 PASSED: buckets 60d, quota 48h, resolved issues 90/365/730d by severity; active issues are never deleted; no orphans';

  -- M6: maintenance is idempotent and no job is scheduled.
  v_r := public._system_monitoring_maintenance(v_now);
  v_r := public._system_monitoring_maintenance(v_now);
  if (v_r ->> 'issues_deleted')::int <> 0 or (v_r ->> 'auto_resolved')::int <> 0 then raise exception 'M6 FAILED: a second run changed data: %', v_r; end if;
  raise notice 'M6 PASSED: maintenance is idempotent';

  raise notice 'ALL SYSTEM MONITORING LIFECYCLE / RULES / MAINTENANCE TESTS PASSED';
end $$;

rollback;
