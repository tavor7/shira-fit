-- System monitoring, Phase 3E.2: server-side hardening of the untrusted client entry point (report_client_error).
-- SERVER ONLY. Client reporting stays OFF: client_ingest_enabled is not touched (it stays false), nothing in the
-- application calls report_client_error, and a client report is still rejected as 'disabled' before any of the new logic runs.
--
-- All client-side behaviour below applies while client_require_rule is true (the default). An explicit JSON false restores the legacy
-- Phase 1 permissive behaviour; it exists only so the legacy ingestion-mechanics tests (136-140) keep running and is never set in production.
--
-- What this migration does (everything else in the monitoring system, including the trusted path used by Phase 2.4,
-- is byte-for-byte unchanged):
--   1. DEFAULT DENY. A client report is accepted only if an enabled system_issue_rules row flagged authorizes_client matches
--      its source/operation/error_class/error_code EXACTLY. A table CHECK makes such a rule structurally exact (no wildcard,
--      explicit class and code, warning-or-lower severity cap, classify/telemetry only), so no broad/prefix/presentation rule
--      can ever authorize ingestion. An empty allowlist accepts nothing. The switch client_require_rule defaults to TRUE
--      (also when the config row is missing); only an explicit JSON false would restore the old permissive behaviour.
--   2. Strict payload validation (_system_client_payload_valid) before any table access: only the ten documented keys,
--      strict patterns and bounds, flat scalar context. user_id/role/source/fingerprint_key/subsystem/impact/entities/stack/route/
--      count/origin or any unknown key => 'invalid_payload'.
--   3. Stable fingerprint: client message text, context, version/build/platform/env and the severity hint are not inputs.
--      Identity = source + subsystem + operation + class + code.
--   4. Server-controlled text and severity: the stored message/summary is the matched rule's title (no client text is stored);
--      the client severity is ignored (every client report starts at 'warning'; floor/cap and the existing escalation decide;
--      never critical).
--   5. _system_monitoring_maintenance: quiet auto-resolve never applies to source='client'. Nothing is scheduled here.
--   6. Seeds the allowlist (idempotent, ON CONFLICT DO NOTHING; unrelated rules are never touched).
--
-- Allowlist naming contract (for the future client, Phase 3E.3):
--   operation 'rpc/<rpc name>'  class 'RpcOutcome'      code = registry code (HTTP 2xx ok:false, or the RAISE token of a 4xx P0001)
--   operation 'rpc/<rpc name>'  class 'RpcReason'       code = reviewed 'reason' code (manager_activity_revert_info)
--   operation 'rpc/postgrest'   class 'PostgrestError'  code = exact SQLSTATE / PGRST code (RPC name goes in context.rpc)
--   operation 'transport/infra' class 'HttpError'       code = http_502 | http_503 | http_504
--   operation 'transport/server' class 'HttpError'      code = http_500
-- Deliberately NOT allowlisted (cannot be represented as exact rules, or not reviewed as technical): business, authorization/
-- validation, uncertain and unknown outcomes; arbitrary HTTP 4xx; SQLSTATE codes outside the exact list below; other 5xx statuses;
-- 408/429; network failures; per-RPC transport operations; every client-side code family.
-- No business data is read or written.

-- 1. rule schema ---------------------------------------------------------------------------------------------------------
alter table public.system_issue_rules add column if not exists authorizes_client boolean not null default false;

alter table public.system_issue_rules drop constraint if exists system_issue_rules_client_auth_exact;
alter table public.system_issue_rules add constraint system_issue_rules_client_auth_exact check (
  not authorizes_client or (
    match_source = 'client'
    and match_operation is not null and match_operation !~ '[*]'
    and match_error_class is not null
    and match_error_code is not null
    and action in ('classify', 'telemetry')
    and severity_cap in ('info', 'warning', 'error')
    and (severity_floor is null or severity_floor in ('info', 'warning', 'error'))
  )
);

create unique index if not exists system_issue_rules_client_auth_uq
  on public.system_issue_rules (match_operation, match_error_class, match_error_code)
  where authorizes_client;

comment on column public.system_issue_rules.authorizes_client is
  'TRUE only for an exact (source=client, operation, error_class, error_code) allowlist entry for untrusted client reports. '
  'Enforced exact by system_issue_rules_client_auth_exact. Wildcard and presentation rules never authorize ingestion.';

insert into public.system_monitoring_config (key, value) values ('client_require_rule', 'true'::jsonb)
on conflict (key) do nothing;

-- 2. strict payload validation ------------------------------------------------------------------------------------------
create or replace function public._system_client_payload_valid(p_payload jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c_keys constant text[] := array['operation', 'error_class', 'error_code', 'message', 'severity', 'context', 'app_version', 'build', 'platform', 'env'];
  k text;
  v jsonb;
  v_n integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p_payload) loop
    if not (k = any (c_keys)) then
      return false;
    end if;
  end loop;
  -- the identity of an approved failure is mandatory and strictly shaped
  if public._system_pick_text(p_payload -> 'operation', '^[a-z_]{2,16}/[A-Za-z0-9_./:-]{1,100}$') is null
     or public._system_pick_text(p_payload -> 'error_class', '^[A-Za-z0-9_.$-]{1,80}$') is null
     or public._system_pick_text(p_payload -> 'error_code', '^[A-Za-z0-9_.-]{1,40}$') is null then
    return false;
  end if;
  -- optional fields: if present they must be well formed (never silently coerced)
  if p_payload ? 'message' and not (jsonb_typeof(p_payload -> 'message') = 'string' and char_length(p_payload ->> 'message') <= 300) then
    return false;
  end if;
  if p_payload ? 'severity' and public._system_pick_text(p_payload -> 'severity', '^[a-z]{1,16}$') is null then
    return false;
  end if;
  if p_payload ? 'app_version' and public._system_pick_text(p_payload -> 'app_version', '^[A-Za-z0-9._+-]{1,32}$') is null then
    return false;
  end if;
  if p_payload ? 'build' and public._system_pick_text(p_payload -> 'build', '^[A-Za-z0-9._+-]{1,32}$') is null then
    return false;
  end if;
  if p_payload ? 'platform' and public._system_pick_text(p_payload -> 'platform', '^(ios|android|web)$') is null then
    return false;
  end if;
  if p_payload ? 'env' and public._system_pick_text(p_payload -> 'env', '^[a-z]{2,16}$') is null then
    return false;
  end if;
  if p_payload ? 'context' then
    if jsonb_typeof(p_payload -> 'context') <> 'object' then
      return false;
    end if;
    for k, v in select e.key, e.value from jsonb_each(p_payload -> 'context') e loop
      v_n := v_n + 1;
      if v_n > 16 or jsonb_typeof(v) in ('object', 'array') or char_length(k) > 40 then
        return false;
      end if;
    end loop;
  end if;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public._system_client_payload_valid(jsonb) from public, anon, authenticated, service_role;

-- 3. ingestion worker (only the marked Phase 3E.2 parts differ from 20261006120000) -------------------------------------
create or replace function public._system_ingest_impl(p_trust text, p_payload jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_global_client constant uuid := '00000000-0000-0000-0000-000000000000';
  c_global_trusted constant uuid := '00000000-0000-0000-0000-000000000001';
  v_require_rule boolean;
  v_trusted boolean := (p_trust = 'trusted');
  v_now timestamptz := now();
  v_hour timestamptz := date_trunc('hour', now());
  v_retry integer := greatest(1, ceil(extract(epoch from (date_trunc('hour', now()) + interval '1 hour' - now())))::integer);

  v_limit integer;
  v_source text;
  v_hint text;
  v_subsys text;
  v_default_subsys text;
  v_op text;
  v_class text;
  v_code text;
  v_msg_raw text;
  v_message text;
  v_summary text;
  v_stack text;
  v_route text;
  v_version text;
  v_build text;
  v_platform text;
  v_env text;
  v_entities jsonb;
  v_context jsonb;
  v_user uuid;
  v_role text;
  v_key text;
  v_origin text;
  v_count integer;
  v_template text;
  v_fp text;

  v_rule public.system_issue_rules;
  v_telemetry boolean;
  v_base text;
  v_title text;
  v_impact text;
  v_subsys_eff text;

  v_breaker integer;
  v_events_hour integer;
  v_events_max integer;
  v_esc_hour integer;
  v_flap_days integer;
  v_flap_n integer;

  v_issue_id uuid;
  v_new_id uuid;
  v_created boolean := false;
  v_bucket_done boolean := false;
  v_bcount integer;
  v_bsampled integer;
  v_old public.system_issues;
  v_status text;
  v_resolution text;
  v_muted_until timestamptz;
  v_reopen_count integer;
  v_reopened_at timestamptz;
  v_resolved_at timestamptz;
  v_resolved_by uuid;
  v_regressed text;
  v_reopened boolean := false;
  v_cand integer;
  v_sev_new text;
  v_base_new text;
  v_sev_up boolean := false;
  v_flap integer;
  v_reason text;
  v_sampled integer;
  v_total integer;
  v_deleted integer;
  v_ack_at timestamptz;
  v_ack_by uuid;
  v_dummy integer;
  v_peek_status text;
  v_need_detail boolean := true;
  v_try integer;
begin
  -- ---- switches and shape ----
  if not public._system_flag('ingest_enabled', true) then
    return jsonb_build_object('accepted', false, 'reason', 'disabled');
  end if;
  if p_trust = 'client' and not public._system_flag('client_ingest_enabled', false) then
    return jsonb_build_object('accepted', false, 'reason', 'disabled');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('accepted', false, 'reason', 'invalid_payload');
  end if;
  v_limit := case when v_trusted
    then public._system_limit('max_payload_bytes_trusted', 65536, 1024, 1048576)
    else public._system_limit('max_payload_bytes_client', 16384, 512, 262144) end;
  if octet_length(p_payload::text) > v_limit then
    return jsonb_build_object('accepted', false, 'reason', 'too_large');
  end if;

  -- Phase 3E.2: default-deny switch, read once. TRUE unless an explicit JSON false is configured. False restores the legacy Phase 1
  -- permissive client behaviour and exists only so the legacy mechanics tests can run; it is never set in production.
  v_require_rule := public._system_flag('client_require_rule', true);
  -- ---- identity (never taken from the client payload) ----
  if p_trust = 'client' then
    if p_actor is null then
      return jsonb_build_object('accepted', false, 'reason', 'unauthenticated');
    end if;
    -- Phase 3E.2: strict shape/pattern validation of the untrusted payload BEFORE any table is touched
    -- (a malformed or over-privileged payload costs no database work and consumes no quota).
    if v_require_rule and not public._system_client_payload_valid(p_payload) then
      return jsonb_build_object('accepted', false, 'reason', 'invalid_payload');
    end if;
    select p.role::text into v_role
    from public.profiles p
    where p.user_id = p_actor and p.disabled_at is null;
    if not found then
      return jsonb_build_object('accepted', false, 'reason', 'not_allowed');
    end if;
    v_user := p_actor;
  elsif v_trusted then
    v_user := (public._system_pick_text(p_payload -> 'user_id', c_uuid))::uuid;
    v_role := public._system_pick_text(p_payload -> 'user_role', '^(athlete|coach|manager)$');
  else
    return jsonb_build_object('accepted', false, 'reason', 'invalid_trust');
  end if;

  -- ---- field validation / sanitization ----
  v_source := case when v_trusted
    then coalesce(public._system_pick_text(p_payload -> 'source', '^[a-z][a-z0-9_]{1,31}$'), 'unknown')
    else 'client' end;
  v_hint := public._system_pick_text(p_payload -> 'severity', '^(info|warning|error|critical)$');
  if v_trusted then
    v_hint := coalesce(v_hint, 'error');
  else
    -- Untrusted (Phase 3E.2): with default-deny on, the severity hint of a client is never read. Every client report starts at
    -- 'warning'; the matched rule's floor/cap and the server's own escalation decide the rest.
    if v_require_rule then
      v_hint := 'warning';
    else
      v_hint := case when v_hint in ('info', 'warning', 'error') then v_hint else 'error' end;
    end if;
  end if;

  v_default_subsys := case v_source
    when 'client' then 'client' when 'db' then 'database' when 'edge' then 'edge' when 'cron' then 'cron'
    else 'unclassified' end;
  v_subsys := case when v_trusted
    then coalesce(public._system_pick_text(p_payload -> 'subsystem', '^[a-z][a-z0-9_.-]{0,47}$'), v_default_subsys)
    else v_default_subsys end;

  v_op := case when v_trusted
    then public._system_pick_text(p_payload -> 'operation', '^[A-Za-z0-9_./:-]{1,120}$')
    else public._system_pick_text(p_payload -> 'operation', '^[a-z_]{2,16}/[A-Za-z0-9_./:-]{1,100}$') end;
  v_op := coalesce(v_op, 'unspecified');
  -- Volatile identifiers must never fragment issues through the operation name.
  v_op := regexp_replace(v_op, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', ':uuid', 'g');
  v_op := regexp_replace(v_op, '[0-9]{7,}', ':n', 'g');
  v_op := left(v_op, 120);

  v_class := public._system_pick_text(p_payload -> 'error_class', '^[A-Za-z0-9_.$-]{1,80}$');
  v_code := public._system_pick_text(p_payload -> 'error_code', '^[A-Za-z0-9_.-]{1,40}$');

  v_msg_raw := case when jsonb_typeof(p_payload -> 'message') = 'string' then p_payload ->> 'message' else null end;
  -- Phase 3E.2: client message text never reaches the fingerprint (nor storage, see below).
  v_template := case when p_trust = 'client' and v_require_rule then '' else public._system_normalize_template(v_msg_raw) end;

  v_key := case when v_trusted
    then public._system_pick_text(p_payload -> 'fingerprint_key', '^[a-z0-9_:.-]{1,160}$') else null end;
  v_origin := case
    when v_trusted then coalesce(public._system_pick_text(p_payload -> 'origin', '^[A-Za-z0-9_./:-]{1,80}$'), '')
    else public._system_stack_origin(case when jsonb_typeof(p_payload -> 'stack') = 'string' then p_payload ->> 'stack' else null end)
  end;
  v_count := 1;
  if v_trusted and jsonb_typeof(p_payload -> 'count') = 'number' and (p_payload ->> 'count') ~ '^[0-9]{1,6}$' then
    v_count := least(greatest((p_payload ->> 'count')::integer, 1), 100000);
  end if;

  -- ---- fingerprint (server-side only; a client-supplied fingerprint is never read) ----
  v_fp := public._system_fingerprint(v_source, v_subsys, v_op, v_class, v_code, v_template, v_origin, v_key);

  -- ---- classification ----
  begin
    if p_trust = 'client' and v_require_rule then
      -- Phase 3E.2 DEFAULT DENY: only an enabled rule flagged authorizes_client whose source/operation/class/code
      -- are exactly this report's (the table constraint forbids wildcards on such rules) lets a client report in.
      -- Wildcard / presentation rules never authorize anything.
      select * into v_rule
      from public.system_issue_rules x
      where x.enabled and x.authorizes_client
        and x.match_source = 'client' and x.match_operation = v_op
        and x.match_error_class = v_class and x.match_error_code = v_code;
      if not found then
        v_rule := null;
      end if;
    else
      v_rule := public._system_pick_rule(v_source, v_op, v_class, v_code);
    end if;
  exception when others then
    v_rule := null;
  end;
  if p_trust = 'client' and v_require_rule and v_rule.id is null then
    return jsonb_build_object('accepted', false, 'reason', 'not_allowlisted');
  end if;
  if p_trust = 'client' and v_require_rule then
    -- Stored text is the server's own (the rule title); no client-supplied text is ever stored.
    v_msg_raw := v_rule.set_title;
  end if;
  if v_rule.id is not null and v_rule.action = 'ignore' then
    return jsonb_build_object('accepted', false, 'reason', 'ignored');
  end if;
  v_telemetry := (v_rule.id is not null and v_rule.action = 'telemetry');


  -- ---- untrusted quota: per-user reports/hour ----
  if p_trust = 'client' then
    insert into public.system_report_quota as q (user_id, bucket_start, reports, new_fingerprints)
    values (p_actor, v_hour, 1, 0)
    on conflict (user_id, bucket_start)
      do update set reports = q.reports + 1
      where q.reports < public._system_limit('user_reports_per_hour', 20, 1, 100000)
    returning q.reports into v_dummy;
    if not found then
      return jsonb_build_object('accepted', false, 'reason', 'user_quota', 'retry_after_s', v_retry);
    end if;
  end if;

  -- ---- does the issue already exist? then the per-fingerprint breaker applies first ----
  select i.id, i.status into v_issue_id, v_peek_status from public.system_issues i where i.fingerprint = v_fp;
  if v_issue_id is not null then
    -- Hold a KEY SHARE lock on the row until this transaction ends: retention (which needs an exclusive
    -- lock to delete) can then neither delete the issue under us nor lose this report; other reports are
    -- not blocked (KEY SHARE does not conflict with the NO KEY UPDATE of a repeat). If the row has just
    -- been deleted, this report simply creates a fresh issue below.
    perform 1 from public.system_issues where id = v_issue_id for key share;
    if not found then
      v_issue_id := null;
      v_peek_status := null;
    end if;
  end if;
  if v_issue_id is not null then
    v_breaker := public._system_limit('breaker_per_hour', 1000, 1, 1000000);
    insert into public.system_issue_buckets as b (issue_id, bucket_start, count)
    values (v_issue_id, v_hour, v_count)
    on conflict (issue_id, bucket_start)
      do update set count = b.count + v_count where b.count < v_breaker
    returning b.count, b.sampled into v_bcount, v_bsampled;
    if found then
      v_bucket_done := true;
      -- The expensive text sanitization is only needed when this report will be recorded in detail:
      -- a sampled event is still available this hour, or a state change (reopen / escalation) is likely.
      v_events_hour := public._system_limit('events_per_issue_per_hour', 5, 0, 1000);
      v_esc_hour := public._system_limit('escalate_warning_to_error_per_hour', 10, 1, 1000000);
      v_need_detail := (v_bsampled < v_events_hour) or v_peek_status = 'resolved'
                        or (v_bcount >= v_esc_hour and v_bcount - v_count < v_esc_hour);
    else
      update public.system_issue_buckets
      set breaker_tripped_at = coalesce(breaker_tripped_at, v_now)
      where issue_id = v_issue_id and bucket_start = v_hour and breaker_tripped_at is null;
      return jsonb_build_object('accepted', false, 'reason', 'throttled', 'retry_after_s', v_retry);
    end if;
  else
    -- A new issue: bound how many distinct issues one user / the whole tier may create per hour.
    if p_trust = 'client' then
      update public.system_report_quota
      set new_fingerprints = new_fingerprints + 1
      where user_id = p_actor and bucket_start = v_hour
        and new_fingerprints < public._system_limit('user_new_fingerprints_per_hour', 5, 1, 100000);
      if not found then
        return jsonb_build_object('accepted', false, 'reason', 'user_new_fingerprints', 'retry_after_s', v_retry);
      end if;
      insert into public.system_report_quota as q (user_id, bucket_start, reports, new_fingerprints)
      values (c_global_client, v_hour, 0, 1)
      on conflict (user_id, bucket_start)
        do update set new_fingerprints = q.new_fingerprints + 1
        where q.new_fingerprints < public._system_limit('client_new_issues_per_hour', 100, 1, 1000000)
      returning q.new_fingerprints into v_dummy;
      if not found then
        return jsonb_build_object('accepted', false, 'reason', 'global_new_fingerprints', 'retry_after_s', v_retry);
      end if;
    else
      insert into public.system_report_quota as q (user_id, bucket_start, reports, new_fingerprints)
      values (c_global_trusted, v_hour, 0, 1)
      on conflict (user_id, bucket_start)
        do update set new_fingerprints = q.new_fingerprints + 1
        where q.new_fingerprints < public._system_limit('trusted_new_issues_per_hour', 500, 1, 1000000)
      returning q.new_fingerprints into v_dummy;
      if not found then
        return jsonb_build_object('accepted', false, 'reason', 'global_new_fingerprints', 'retry_after_s', v_retry);
      end if;
    end if;

  end if;

  -- ---- Phase B: sanitize stored fields and classify (only after the limits above passed) ----
  v_version := public._system_pick_text(p_payload -> 'app_version', '^[A-Za-z0-9._+-]{1,32}$');
  v_build := public._system_pick_text(p_payload -> 'build', '^[A-Za-z0-9._+-]{1,32}$');
  v_platform := public._system_pick_text(p_payload -> 'platform', '^(ios|android|web|server)$');
  if not v_trusted and v_platform = 'server' then
    v_platform := null;
  end if;
  v_env := public._system_pick_text(p_payload -> 'env', '^[a-z]{2,16}$');
  if v_need_detail then
  v_message := public._system_redact(v_msg_raw, 500, false);
  v_summary := coalesce(public._system_redact(v_msg_raw, 300, false), '');
  v_stack := public._system_redact(
    case when jsonb_typeof(p_payload -> 'stack') = 'string' then p_payload ->> 'stack' else null end,
    2000, true);

  v_route := public._system_redact(
    case when jsonb_typeof(p_payload -> 'route') = 'string' then p_payload ->> 'route' else null end, 120, false);
  if v_route is not null and v_route !~ '^[]A-Za-z0-9_./:()@<>*[-]{1,120}$' then
    v_route := null;
  end if;
  v_entities := public._system_sanitize_map(p_payload -> 'entities', 'entities');
  v_context := public._system_sanitize_map(p_payload -> 'context', 'context');
  end if;

  v_base := v_hint;
  if v_rule.id is not null then
    if public._system_sev_rank(v_rule.severity_floor) > public._system_sev_rank(v_base) then
      v_base := v_rule.severity_floor;
    end if;
    if public._system_sev_rank(v_rule.severity_cap) > 0
       and public._system_sev_rank(v_rule.severity_cap) < public._system_sev_rank(v_base) then
      v_base := v_rule.severity_cap;
    end if;
    v_impact := case when v_rule.impact in ('degraded', 'blocking', 'data_risk', 'financial_risk') then v_rule.impact else null end;
  end if;
  if v_telemetry then
    v_base := 'info';
  end if;
  if p_trust = 'client' and public._system_sev_rank(v_base) > 3 then
    v_base := 'error'; -- a client report can never be critical
  end if;
  v_subsys_eff := v_subsys;
  if v_rule.id is not null and v_rule.set_subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$' then
    v_subsys_eff := v_rule.set_subsystem;
  end if;
  v_title := null;
  if v_rule.id is not null and v_rule.set_title is not null and char_length(v_rule.set_title) between 1 and 160 then
    v_title := v_rule.set_title;
  end if;
  v_title := coalesce(v_title, left(v_subsys_eff || ': ' || v_op || coalesce(' (' || v_code || ')', ''), 160));

  -- ---- create the issue (first report of this fingerprint) ----
  if v_issue_id is null then
    v_need_detail := true;
    for v_try in 1..3 loop
      insert into public.system_issues (
        fingerprint, source, reported_subsystem, subsystem, operation, error_class, error_code, title,
        latest_summary, base_severity, severity, impact, status, first_seen, last_seen, occurrence_count,
        first_seen_version, last_seen_version, rule_id
      ) values (
        v_fp, v_source, v_subsys, v_subsys_eff, v_op, v_class, v_code, v_title,
        case when v_summary = '' then left(v_title, 300) else v_summary end, v_base, v_base, v_impact,
        case when v_telemetry then 'muted' else 'open' end, v_now, v_now, v_count,
        v_version, v_version, v_rule.id
      )
      on conflict (fingerprint) do nothing
      returning id into v_new_id;

      if v_new_id is not null then
        v_created := true;
        v_issue_id := v_new_id;
        insert into public.system_issue_buckets (issue_id, bucket_start, count, sampled)
        values (v_issue_id, v_hour, v_count, case when v_telemetry then 0 else 1 end);
        insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
        values (v_issue_id, v_now, null, case when v_telemetry then 'muted' else 'open' end, 'create', null);
        if not v_telemetry then
          insert into public.system_issue_events (
            issue_id, occurred_at, severity, app_version, build, platform, env, route, user_id, user_role,
            entities, message, stack, context, sample_reason, coalesced_count
          ) values (
            v_issue_id, v_now, v_base, v_version, v_build, v_platform, v_env, v_route, v_user, v_role,
            v_entities, v_message, v_stack, v_context, 'first', v_count
          );
        end if;
        exit;
      end if;

      -- A concurrent report created it first (or it was just deleted by retention): lock it against
      -- deletion and continue on the update path, or retry the insert if it has vanished again.
      select i.id into v_issue_id from public.system_issues i where i.fingerprint = v_fp;
      if v_issue_id is not null then
        perform 1 from public.system_issues where id = v_issue_id for key share;
        if found then
          exit;
        end if;
        v_issue_id := null;
      end if;
    end loop;
    if v_issue_id is null then
      return jsonb_build_object('accepted', false, 'reason', 'raced');
    end if;
  end if;

  -- ---- update path (existing issue) ----
  if not v_created then
    v_esc_hour := public._system_limit('escalate_warning_to_error_per_hour', 10, 1, 1000000);
    v_flap_days := public._system_limit('flap_window_days', 30, 1, 3650);
    v_flap_n := public._system_limit('flap_reopens', 3, 2, 1000);
    v_events_hour := public._system_limit('events_per_issue_per_hour', 5, 0, 1000);
    v_events_max := public._system_limit('max_events_per_issue', 50, 1, 10000);
    if not v_bucket_done then
      insert into public.system_issue_buckets as b (issue_id, bucket_start, count)
      values (v_issue_id, v_hour, v_count)
      on conflict (issue_id, bucket_start) do update set count = b.count + v_count
      returning b.count, b.sampled into v_bcount, v_bsampled;
    end if;

    select * into v_old from public.system_issues where id = v_issue_id for no key update;
    if not found then
      return jsonb_build_object('accepted', false, 'reason', 'raced');
    end if;

    v_status := v_old.status;
    v_resolution := v_old.resolution;
    v_muted_until := v_old.muted_until;
    v_reopen_count := v_old.reopen_count;
    v_reopened_at := v_old.reopened_at;
    v_resolved_at := v_old.resolved_at;
    v_resolved_by := v_old.resolved_by;
    v_regressed := v_old.regressed_in_version;
    v_ack_at := v_old.acknowledged_at;
    v_ack_by := v_old.acknowledged_by;
    v_base_new := public._system_rank_sev(greatest(public._system_sev_rank(v_old.base_severity), public._system_sev_rank(v_base)));
    v_sev_new := v_old.severity;

    -- An expired mute ends at the next occurrence even if maintenance has not run.
    if v_status = 'muted' and v_muted_until is not null and v_muted_until <= v_now and not v_telemetry then
      insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
      values (v_issue_id, v_now, 'muted', 'open', 'auto_unmute', null);
      v_status := 'open';
      v_muted_until := null;
      v_resolution := null;
      v_ack_at := null;
      v_ack_by := null;
    end if;

    if v_telemetry then
      -- Telemetry-only class: counters only, never an active issue.
      if v_status <> 'muted' then
        insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
        values (v_issue_id, v_now, v_status, 'muted', 'mute', null);
        v_status := 'muted';
        v_resolution := null;
        v_muted_until := null;
      end if;
      v_sev_new := 'info';
    elsif v_status = 'muted' then
      null; -- counters only: a muted issue neither escalates nor reopens
    else
      if v_status = 'resolved' then
        -- Recurrence after resolution always reopens (manual resolution never hides a recurring failure).
        v_reopened := true;
        v_status := 'open';
        v_reopen_count := v_reopen_count + 1;
        v_reopened_at := v_now;
        v_resolution := null;
        v_resolved_at := null;
        v_resolved_by := null;
        v_ack_at := null;
        v_ack_by := null;
        if v_version is not null and v_version is distinct from v_old.resolved_version then
          v_regressed := v_version;
        end if;
        insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
        values (v_issue_id, v_now, 'resolved', 'open', 'auto_reopen', null);
      end if;

      v_cand := greatest(public._system_sev_rank(v_old.severity), public._system_sev_rank(v_base_new));
      -- Volume escalation: a warning-level issue that recurs heavily within the hour becomes an error.
      if public._system_sev_rank(v_base_new) = 2 and v_bcount >= v_esc_hour then
        v_cand := greatest(v_cand, 3);
      end if;
      -- Flapping: the third reopen within the window escalates to (at most) error.
      if v_reopened then
        select count(*) into v_flap
        from public.system_issue_transitions t
        where t.issue_id = v_issue_id and t.kind in ('auto_reopen', 'reopen')
          and t.at > v_now - make_interval(days => v_flap_days);
        if v_flap >= v_flap_n then
          v_cand := greatest(v_cand, 3);
        end if;
      end if;
      v_sev_new := public._system_rank_sev(v_cand);
      v_sev_up := public._system_sev_rank(v_sev_new) > public._system_sev_rank(v_old.severity);
      if v_sev_up and v_status = 'acknowledged' then
        insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
        values (v_issue_id, v_now, 'acknowledged', 'open', 'escalate', null);
        v_status := 'open';
        v_ack_at := null;
        v_ack_by := null;
      end if;
    end if;

    update public.system_issues set
      last_seen = greatest(last_seen, v_now),
      occurrence_count = occurrence_count + v_count,
      latest_summary = coalesce(nullif(v_summary, ''), latest_summary),
      base_severity = v_base_new,
      severity = v_sev_new,
      status = v_status,
      resolution = v_resolution,
      muted_until = v_muted_until,
      reopen_count = v_reopen_count,
      reopened_at = v_reopened_at,
      resolved_at = v_resolved_at,
      resolved_by = v_resolved_by,
      acknowledged_at = v_ack_at,
      acknowledged_by = v_ack_by,
      last_seen_version = coalesce(v_version, last_seen_version),
      regressed_in_version = v_regressed,
      subsystem = v_subsys_eff,
      title = v_title,
      impact = v_impact,
      rule_id = v_rule.id
    where id = v_issue_id;

    -- ---- sampled event (bounded: hourly cap, total cap; none for muted / telemetry) ----
    if v_status <> 'muted' and not v_telemetry then
      v_reason := case
        when v_reopened or v_sev_up then 'escalation'
        when v_sev_new = 'critical' then 'critical'
        else 'sampled' end;
      -- Ordinary samples obey the hourly cap. A state change (reopen / escalation) always records its own
      -- event: those are bounded by lifecycle transitions, and the per-issue total cap still applies.
      update public.system_issue_buckets
      set sampled = sampled + 1
      where issue_id = v_issue_id and bucket_start = v_hour and (sampled < v_events_hour or v_reason = 'escalation')
      returning sampled into v_sampled;
      if found then
        select count(*) into v_total from public.system_issue_events where issue_id = v_issue_id;
        if v_total >= v_events_max then
          delete from public.system_issue_events
          where id = (
            select e.id from public.system_issue_events e
            where e.issue_id = v_issue_id and e.sample_reason <> 'first'
            order by e.occurred_at asc limit 1
          );
          get diagnostics v_deleted = row_count;
        else
          v_deleted := 1;
        end if;
        if v_deleted > 0 then
          insert into public.system_issue_events (
            issue_id, occurred_at, severity, app_version, build, platform, env, route, user_id, user_role,
            entities, message, stack, context, sample_reason, coalesced_count
          ) values (
            v_issue_id, v_now, v_sev_new, v_version, v_build, v_platform, v_env, v_route, v_user, v_role,
            v_entities, v_message, v_stack, v_context, v_reason, v_count
          );
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object('accepted', true, 'created', v_created, 'issue_id', v_issue_id);
end;
$$;

-- 4. maintenance (only step 3 differs: client-reported issues never auto-resolve on silence) -----------------------------
create or replace function public._system_monitoring_maintenance(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_batch constant integer := 1000;
  r record;
  v_unmuted integer := 0;
  v_decayed integer := 0;
  v_quiet integer := 0;
  v_events integer := 0;
  v_capped integer := 0;
  v_buckets integer := 0;
  v_issues integer := 0;
  v_quota integer := 0;
  v_n integer;
  v_decay integer := public._system_limit('escalation_decay_hours', 24, 1, 8760);
  v_cap integer := public._system_limit('max_events_per_issue', 50, 1, 10000);
  v_q_info integer := public._system_ret('{quiet_resolve_hours,info}', 24, 1, 2160);
  v_q_warn integer := public._system_ret('{quiet_resolve_hours,warning}', 24, 1, 2160);
  v_q_err integer := public._system_ret('{quiet_resolve_hours,error}', 168, 1, 2160);
  v_hours integer;
begin
  -- 1. Expired mutes.
  for r in
    select i.id from public.system_issues i
    where i.status = 'muted' and i.muted_until is not null and i.muted_until <= p_now
    order by i.muted_until limit c_batch
    for update of i skip locked
  loop
    update public.system_issues
    set status = 'open', muted_until = null, resolution = null, acknowledged_at = null, acknowledged_by = null
    where id = r.id and status = 'muted' and muted_until is not null and muted_until <= p_now;
    if found then
      insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id)
      values (r.id, p_now, 'muted', 'open', 'auto_unmute', null);
      v_unmuted := v_unmuted + 1;
    end if;
  end loop;

  -- 2. Escalation decay: effective severity returns to the declared base after a quiet period.
  update public.system_issues
  set severity = base_severity
  where status in ('open', 'acknowledged')
    and public._system_sev_rank(severity) > public._system_sev_rank(base_severity)
    and last_seen < p_now - make_interval(hours => v_decay);
  get diagnostics v_decayed = row_count;

  -- 3. Quiet auto-resolve (critical never auto-resolves unless its rule says so; client-reported issues never auto-resolve).
  for r in
    select i.id, i.status, i.last_seen, i.severity,
           (select x.quiet_resolve_hours from public.system_issue_rules x where x.id = i.rule_id) as rule_hours
    from public.system_issues i
    where i.status in ('open', 'acknowledged')
      and i.source <> 'client' -- Phase 3E.2: silence never resolves a client-reported technical issue
    order by i.last_seen
    limit c_batch
    for update of i skip locked
  loop
    v_hours := coalesce(r.rule_hours,
      case r.severity when 'info' then v_q_info when 'warning' then v_q_warn when 'error' then v_q_err else null end);
    continue when v_hours is null or r.last_seen >= p_now - make_interval(hours => v_hours);
    update public.system_issues
    set status = 'resolved', resolution = 'auto_quiet', resolved_at = p_now, resolved_by = null,
        resolved_version = last_seen_version, muted_until = null
    where id = r.id and status = r.status and last_seen = r.last_seen;
    if found then
      insert into public.system_issue_transitions (issue_id, at, from_status, to_status, kind, actor_user_id, reason)
      values (r.id, p_now, r.status, 'resolved', 'auto_resolve', null, 'auto_quiet');
      v_quiet := v_quiet + 1;
    end if;
  end loop;

  -- 4a. Event retention by severity (the first occurrence is kept while the issue exists).
  with d as (
    select e.id from public.system_issue_events e
    where e.sample_reason <> 'first'
      and e.occurred_at < p_now - make_interval(days => case e.severity
        when 'info' then public._system_ret('{events_days,info}', 30)
        when 'warning' then public._system_ret('{events_days,warning}', 30)
        when 'error' then public._system_ret('{events_days,error}', 90)
        else public._system_ret('{events_days,critical}', 180) end)
    order by e.occurred_at
    limit 5000
  )
  delete from public.system_issue_events x using d where x.id = d.id;
  get diagnostics v_events = row_count;

  -- 4b. Hard per-issue event cap (keep the first, then the newest).
  with over as (
    select e.issue_id from public.system_issue_events e group by e.issue_id having count(*) > v_cap limit 200
  ), ranked as (
    select e.id, row_number() over (partition by e.issue_id order by (e.sample_reason = 'first') desc, e.occurred_at desc) as rn
    from public.system_issue_events e join over o on o.issue_id = e.issue_id
  )
  delete from public.system_issue_events x using ranked k where x.id = k.id and k.rn > v_cap;
  get diagnostics v_capped = row_count;

  -- 5. Buckets.
  delete from public.system_issue_buckets b
  where (b.issue_id, b.bucket_start) in (
    select b2.issue_id, b2.bucket_start from public.system_issue_buckets b2
    where b2.bucket_start < p_now - make_interval(days => public._system_ret('{buckets_days}', 60))
    limit 5000);
  get diagnostics v_buckets = row_count;

  -- 6. Resolved issues past their retention (predicate re-checked under the row lock).
  for r in
    select i.id, i.resolved_at, i.severity from public.system_issues i
    where i.status = 'resolved'
      and i.resolved_at < p_now - make_interval(days => case i.severity
        when 'info' then public._system_ret('{resolved_issue_days,info}', 90)
        when 'warning' then public._system_ret('{resolved_issue_days,warning}', 90)
        when 'error' then public._system_ret('{resolved_issue_days,error}', 365)
        else public._system_ret('{resolved_issue_days,critical}', 730) end)
    order by i.resolved_at limit 500
    for update of i skip locked
  loop
    delete from public.system_issues where id = r.id and status = 'resolved' and resolved_at = r.resolved_at;
    get diagnostics v_n = row_count;
    v_issues := v_issues + v_n;
  end loop;

  -- 7. Quota rows.
  delete from public.system_report_quota
  where (user_id, bucket_start) in (
    select q.user_id, q.bucket_start from public.system_report_quota q
    where q.bucket_start < p_now - make_interval(hours => public._system_ret('{quota_hours}', 48, 1, 8760))
    limit 5000);
  get diagnostics v_quota = row_count;

  return jsonb_build_object(
    'unmuted', v_unmuted, 'severity_decayed', v_decayed, 'auto_resolved', v_quiet,
    'events_pruned', v_events, 'events_capped', v_capped, 'buckets_pruned', v_buckets,
    'issues_deleted', v_issues, 'quota_pruned', v_quota);
end;
$$;

-- 5. allowlist seed (idempotent; severity capped at warning; subsystem/title are server-side presentation) ---------------
insert into public.system_issue_rules
  (priority, match_source, match_operation, match_error_class, match_error_code, action, set_subsystem, set_title,
   severity_cap, authorizes_client, note)
select 100, 'client', v.op, v.cls, v.code, 'classify', v.subsys, v.title, 'warning', true,
       'Phase 3E.2 seed: reviewed technical failure approved for client reporting'
from (values
  ('rpc/edit_subscription_version', 'RpcOutcome', 'no_current_version', 'rpc', 'RPC technical outcome: edit_subscription_version (no_current_version)'),
  ('rpc/freeze_subscription', 'RpcOutcome', 'no_current_version', 'rpc', 'RPC technical outcome: freeze_subscription (no_current_version)'),
  ('rpc/get_current_legal_document', 'RpcOutcome', 'not_found', 'rpc', 'RPC technical outcome: get_current_legal_document (not_found)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_attendance_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_attendance_context)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_cancellation_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_cancellation_context)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_note_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_note_context)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_registration_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_registration_context)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_role_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_role_context)'),
  ('rpc/manager_activity_revert_info', 'RpcReason', 'missing_status_context', 'rpc', 'RPC technical reason: manager_activity_revert_info (missing_status_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_attendance_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_attendance_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_cancellation_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_cancellation_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_note_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_note_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_registration_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_registration_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_role_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_role_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'missing_status_context', 'rpc', 'RPC technical outcome: manager_revert_activity_event (missing_status_context)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'remove_failed', 'rpc', 'RPC technical outcome: manager_revert_activity_event (remove_failed)'),
  ('rpc/manager_revert_activity_event', 'RpcOutcome', 'restore_failed', 'rpc', 'RPC technical outcome: manager_revert_activity_event (restore_failed)'),
  ('rpc/manager_set_cancellation_charge', 'RpcOutcome', 'session_not_found', 'rpc', 'RPC technical outcome: manager_set_cancellation_charge (session_not_found)'),
  ('rpc/postgrest', 'PostgrestError', '21000', 'database', 'RPC database error: 21000'),
  ('rpc/postgrest', 'PostgrestError', '40001', 'database', 'RPC database error: 40001'),
  ('rpc/postgrest', 'PostgrestError', '40P01', 'database', 'RPC database error: 40P01'),
  ('rpc/postgrest', 'PostgrestError', '42601', 'database', 'RPC database error: 42601'),
  ('rpc/postgrest', 'PostgrestError', '42702', 'database', 'RPC database error: 42702'),
  ('rpc/postgrest', 'PostgrestError', '42703', 'database', 'RPC database error: 42703'),
  ('rpc/postgrest', 'PostgrestError', '42725', 'database', 'RPC database error: 42725'),
  ('rpc/postgrest', 'PostgrestError', '42804', 'database', 'RPC database error: 42804'),
  ('rpc/postgrest', 'PostgrestError', '42846', 'database', 'RPC database error: 42846'),
  ('rpc/postgrest', 'PostgrestError', '42883', 'database', 'RPC database error: 42883'),
  ('rpc/postgrest', 'PostgrestError', '42P01', 'database', 'RPC database error: 42P01'),
  ('rpc/postgrest', 'PostgrestError', '42P02', 'database', 'RPC database error: 42P02'),
  ('rpc/postgrest', 'PostgrestError', '42P18', 'database', 'RPC database error: 42P18'),
  ('rpc/postgrest', 'PostgrestError', '53200', 'database', 'RPC database error: 53200'),
  ('rpc/postgrest', 'PostgrestError', '53300', 'database', 'RPC database error: 53300'),
  ('rpc/postgrest', 'PostgrestError', '54000', 'database', 'RPC database error: 54000'),
  ('rpc/postgrest', 'PostgrestError', '55P03', 'database', 'RPC database error: 55P03'),
  ('rpc/postgrest', 'PostgrestError', '57014', 'database', 'RPC database error: 57014'),
  ('rpc/postgrest', 'PostgrestError', 'P0003', 'database', 'RPC database error: P0003'),
  ('rpc/postgrest', 'PostgrestError', 'P0004', 'database', 'RPC database error: P0004'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST100', 'database', 'RPC database error: PGRST100'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST102', 'database', 'RPC database error: PGRST102'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST103', 'database', 'RPC database error: PGRST103'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST106', 'database', 'RPC database error: PGRST106'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST107', 'database', 'RPC database error: PGRST107'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST111', 'database', 'RPC database error: PGRST111'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST200', 'database', 'RPC database error: PGRST200'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST201', 'database', 'RPC database error: PGRST201'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST202', 'database', 'RPC database error: PGRST202'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST203', 'database', 'RPC database error: PGRST203'),
  ('rpc/postgrest', 'PostgrestError', 'PGRST204', 'database', 'RPC database error: PGRST204'),
  ('rpc/postgrest', 'PostgrestError', 'XX000', 'database', 'RPC database error: XX000'),
  ('rpc/reactivate_subscription', 'RpcOutcome', 'source_has_no_version', 'rpc', 'RPC technical outcome: reactivate_subscription (source_has_no_version)'),
  ('rpc/register_for_session', 'RpcOutcome', 'no_profile', 'rpc', 'RPC technical outcome: register_for_session (no_profile)'),
  ('rpc/stop_subscription', 'RpcOutcome', 'no_current_version', 'rpc', 'RPC technical outcome: stop_subscription (no_current_version)'),
  ('rpc/update_session_note', 'RpcOutcome', 'session_not_found', 'rpc', 'RPC technical outcome: update_session_note (session_not_found)'),
  ('transport/infra', 'HttpError', 'http_502', 'transport', 'Infrastructure unavailable: http_502'),
  ('transport/infra', 'HttpError', 'http_503', 'transport', 'Infrastructure unavailable: http_503'),
  ('transport/infra', 'HttpError', 'http_504', 'transport', 'Infrastructure unavailable: http_504'),
  ('transport/server', 'HttpError', 'http_500', 'transport', 'Server error: http_500')
) as v(op, cls, code, subsys, title)
on conflict (match_operation, match_error_class, match_error_code) where authorizes_client do nothing;

-- 6. self-checks --------------------------------------------------------------------------------------------------------
do $$
begin
  if public._system_flag('client_ingest_enabled', false) then
    raise exception 'self-check: client ingestion must remain disabled';
  end if;
  if not public._system_flag('client_require_rule', false) then
    raise exception 'self-check: client_require_rule must be true';
  end if;
  if (select count(*) from public.system_issue_rules where authorizes_client and enabled) < 58 then
    raise exception 'self-check: allowlist seed is incomplete';
  end if;
  if exists (select 1 from public.system_issue_rules where authorizes_client
             and (match_operation like '%*%' or severity_cap = 'critical' or action = 'ignore')) then
    raise exception 'self-check: an allowlist rule is not exact';
  end if;
  if has_function_privilege('authenticated', 'public._system_client_payload_valid(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public._system_client_payload_valid(jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public._system_client_payload_valid(jsonb)', 'EXECUTE') then
    raise exception 'self-check: _system_client_payload_valid must be internal';
  end if;
  if has_function_privilege('authenticated', 'public._system_ingest_impl(text, jsonb, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.report_client_error(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.system_report_trusted(jsonb)', 'EXECUTE') then
    raise exception 'self-check: function privileges changed';
  end if;
end $$;
