-- System monitoring, Phase 1 (3/3): ingestion, lifecycle, maintenance.
--
-- Entry points and who may call them (everything else is internal and callable by NO API role):
--   report_client_error(jsonb)        authenticated only. UNTRUSTED client boundary. Disabled by
--                                     system_monitoring_config.client_ingest_enabled (default false).
--   system_report_trusted(jsonb)      service_role only (future Edge Functions / trusted server code).
--   _report_system_error(...)         internal; for other SECURITY DEFINER SQL functions (later phases).
--   system_issue_acknowledge / _resolve / _mute / _unmute / _reopen
--                                     authenticated; each checks system_monitoring_is_manager() inside.
--   _system_monitoring_maintenance()  internal; built and tested, NOT scheduled in Phase 1.
--   _system_reapply_rules(uuid[])     internal; re-applies classification rules to existing issues.
--
-- Failure isolation: reporting is best-effort. Every ingestion path catches all errors in its own
-- sub-block, logs only a WARNING and returns {accepted:false}; it never raises into the caller. Function
-- level lock_timeout (200ms) drops a report instead of waiting on a contended row. Nothing here uses
-- autonomous transactions or dblink: a report written from inside PostgreSQL is durable only if the OUTER
-- transaction commits.
--
-- No dynamic SQL is used in ingestion or lifecycle code; every value is a bound variable.

-- ---------------------------------------------------------------------------------------------
-- Core worker. Called only by _system_ingest (which owns error isolation and the re-entrancy guard).
-- p_trust: 'client' (untrusted, p_actor = auth.uid()) or 'trusted'.
-- Returns {accepted: bool, reason?: text, created?: bool, issue_id?: uuid, retry_after_s?: int}.
-- ---------------------------------------------------------------------------------------------
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

  -- ---- identity (never taken from the client payload) ----
  if p_trust = 'client' then
    if p_actor is null then
      return jsonb_build_object('accepted', false, 'reason', 'unauthenticated');
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
    -- Untrusted: a client can never declare critical.
    v_hint := case when v_hint in ('info', 'warning', 'error') then v_hint else 'error' end;
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
  v_template := public._system_normalize_template(v_msg_raw);

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
    v_rule := public._system_pick_rule(v_source, v_op, v_class, v_code);
  exception when others then
    v_rule := null;
  end;
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

-- ---------------------------------------------------------------------------------------------
-- Error-isolating wrapper. NEVER raises. A transaction-local flag stops re-entrancy; any failure in the
-- worker rolls back only the worker's own writes (sub-block) and is reduced to a WARNING.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_ingest(p_trust text, p_payload jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
declare
  v_res jsonb;
begin
  begin
    if current_setting('shira.monitoring_active', true) = 'on' then
      return jsonb_build_object('accepted', false, 'reason', 'reentrant');
    end if;
    perform set_config('shira.monitoring_active', 'on', true);
    begin
      v_res := public._system_ingest_impl(p_trust, p_payload, p_actor);
    exception when others then
      raise warning 'system monitoring: ingestion failed (sqlstate %): %', sqlstate, left(sqlerrm, 200);
      v_res := jsonb_build_object('accepted', false, 'reason', 'internal');
    end;
    perform set_config('shira.monitoring_active', 'off', true);
    return v_res;
  exception when others then
    begin
      perform set_config('shira.monitoring_active', 'off', true);
    exception when others then
      null;
    end;
    return jsonb_build_object('accepted', false, 'reason', 'internal');
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Trusted internal SQL entry point (later phases: swallow sites, detectors, cron wrappers).
-- Returns void and never raises.
-- ---------------------------------------------------------------------------------------------
create or replace function public._report_system_error(
  p_source text,
  p_subsystem text,
  p_operation text,
  p_error_class text default null,
  p_error_code text default null,
  p_message text default null,
  p_severity text default 'error',
  p_entities jsonb default '{}'::jsonb,
  p_context jsonb default '{}'::jsonb,
  p_fingerprint_key text default null,
  p_count integer default 1,
  p_origin text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
begin
  perform public._system_ingest(
    'trusted',
    jsonb_strip_nulls(jsonb_build_object(
      'source', p_source, 'subsystem', p_subsystem, 'operation', p_operation,
      'error_class', p_error_class, 'error_code', p_error_code, 'message', p_message,
      'severity', p_severity, 'entities', coalesce(p_entities, '{}'::jsonb), 'context', coalesce(p_context, '{}'::jsonb),
      'fingerprint_key', p_fingerprint_key, 'count', p_count, 'origin', p_origin)),
    null);
exception when others then
  begin
    raise warning 'system monitoring: _report_system_error failed (sqlstate %)', sqlstate;
  exception when others then
    null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Trusted external entry point: service_role only (Edge Functions with the service key, later).
-- ---------------------------------------------------------------------------------------------
create or replace function public.system_report_trusted(p_payload jsonb)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
declare
  v_res jsonb;
begin
  v_res := public._system_ingest('trusted', p_payload, null);
  return json_build_object('ok', true, 'accepted', coalesce((v_res ->> 'accepted')::boolean, false),
                           'reason', v_res ->> 'reason');
exception when others then
  return json_build_object('ok', true, 'accepted', false, 'reason', 'internal');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Untrusted authenticated client entry point. Identity comes from auth.uid() only; source, severity
-- ceiling, subsystem, impact, lifecycle, rule and fingerprint are all decided server-side.
-- Disabled by configuration until a later phase wires the application to it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.report_client_error(p_payload jsonb)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '200ms'
as $$
declare
  v_uid uuid;
  v_res jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return json_build_object('ok', true, 'accepted', false, 'reason', 'unauthenticated');
  end if;
  v_res := public._system_ingest('client', p_payload, v_uid);
  return json_build_object(
    'ok', true,
    'accepted', coalesce((v_res ->> 'accepted')::boolean, false),
    'reason', v_res ->> 'reason',
    'retry_after_s', (v_res ->> 'retry_after_s')::integer);
exception when others then
  return json_build_object('ok', true, 'accepted', false, 'reason', 'internal');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Manager lifecycle RPCs. Each: (1) re-checks system_monitoring_is_manager(), (2) locks the issue row,
-- (3) validates the transition, (4) updates + appends a transition row. Convention: {ok, error}.
-- ---------------------------------------------------------------------------------------------
create or replace function public.system_issue_acknowledge(p_issue_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i public.system_issues;
begin
  if not public.system_monitoring_is_manager() then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_i from public.system_issues where id = p_issue_id for no key update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_i.status = 'acknowledged' then
    return json_build_object('ok', true, 'status', 'acknowledged');
  end if;
  if v_i.status <> 'open' then
    return json_build_object('ok', false, 'error', 'invalid_state', 'status', v_i.status);
  end if;
  update public.system_issues
  set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_uid
  where id = p_issue_id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id)
  values (p_issue_id, 'open', 'acknowledged', 'ack', v_uid);
  return json_build_object('ok', true, 'status', 'acknowledged');
end;
$$;

create or replace function public.system_issue_resolve(
  p_issue_id uuid,
  p_reason text default 'manual_fixed',
  p_expected_last_seen timestamptz default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i public.system_issues;
begin
  if not public.system_monitoring_is_manager() then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_reason is null or p_reason not in ('manual_fixed', 'manual_expected') then
    return json_build_object('ok', false, 'error', 'invalid_reason');
  end if;
  select * into v_i from public.system_issues where id = p_issue_id for no key update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_i.status = 'resolved' then
    return json_build_object('ok', false, 'error', 'invalid_state', 'status', v_i.status);
  end if;
  -- Optimistic check: never bury an occurrence the manager has not seen.
  if p_expected_last_seen is not null and v_i.last_seen > p_expected_last_seen then
    return json_build_object('ok', false, 'error', 'stale', 'last_seen', v_i.last_seen);
  end if;
  update public.system_issues
  set status = 'resolved', resolution = p_reason, resolved_at = now(), resolved_by = v_uid,
      resolved_version = last_seen_version, muted_until = null
  where id = p_issue_id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id, reason)
  values (p_issue_id, v_i.status, 'resolved', 'resolve', v_uid, p_reason);
  return json_build_object('ok', true, 'status', 'resolved');
end;
$$;

create or replace function public.system_issue_mute(p_issue_id uuid, p_until timestamptz default null)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i public.system_issues;
begin
  if not public.system_monitoring_is_manager() then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_until is not null and (p_until <= now() or p_until > now() + interval '365 days') then
    return json_build_object('ok', false, 'error', 'invalid_until');
  end if;
  select * into v_i from public.system_issues where id = p_issue_id for no key update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_i.status not in ('open', 'acknowledged') then
    return json_build_object('ok', false, 'error', 'invalid_state', 'status', v_i.status);
  end if;
  update public.system_issues
  set status = 'muted', resolution = 'manual_expected', muted_until = p_until
  where id = p_issue_id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id, reason)
  values (p_issue_id, v_i.status, 'muted', 'mute', v_uid, 'manual_expected');
  return json_build_object('ok', true, 'status', 'muted');
end;
$$;

create or replace function public.system_issue_unmute(p_issue_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i public.system_issues;
begin
  if not public.system_monitoring_is_manager() then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_i from public.system_issues where id = p_issue_id for no key update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_i.status <> 'muted' then
    return json_build_object('ok', false, 'error', 'invalid_state', 'status', v_i.status);
  end if;
  update public.system_issues
  set status = 'open', resolution = null, muted_until = null, acknowledged_at = null, acknowledged_by = null
  where id = p_issue_id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id)
  values (p_issue_id, 'muted', 'open', 'unmute', v_uid);
  return json_build_object('ok', true, 'status', 'open');
end;
$$;

create or replace function public.system_issue_reopen(p_issue_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i public.system_issues;
begin
  if not public.system_monitoring_is_manager() then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_i from public.system_issues where id = p_issue_id for no key update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_i.status <> 'resolved' then
    return json_build_object('ok', false, 'error', 'invalid_state', 'status', v_i.status);
  end if;
  update public.system_issues
  set status = 'open', resolution = null, resolved_at = null, resolved_by = null,
      reopen_count = reopen_count + 1, reopened_at = now(), acknowledged_at = null, acknowledged_by = null
  where id = p_issue_id;
  insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id)
  values (p_issue_id, 'resolved', 'open', 'reopen', v_uid);
  return json_build_object('ok', true, 'status', 'open');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Maintenance: auto-unmute, severity decay, quiet auto-resolve, retention. Internal, bounded per run,
-- row-locked with predicate re-checks so it can never race a new occurrence into data loss.
-- p_now is a parameter only so tests can age data; callers use the default.
-- NOT SCHEDULED in Phase 1 (no pg_cron job is created here).
-- ---------------------------------------------------------------------------------------------
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

  -- 3. Quiet auto-resolve (critical never auto-resolves unless its rule says so).
  for r in
    select i.id, i.status, i.last_seen, i.severity,
           (select x.quiet_resolve_hours from public.system_issue_rules x where x.id = i.rule_id) as rule_hours
    from public.system_issues i
    where i.status in ('open', 'acknowledged')
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

-- ---------------------------------------------------------------------------------------------
-- Re-apply rules to existing issues (developer tool after editing system_issue_rules).
-- Recomputes subsystem/title/impact/rule_id and applies the rule's floor/cap to base_severity (the
-- original hint is not stored, so a removed floor cannot be undone automatically). A telemetry rule
-- mutes the issue. Returns the number of issues touched.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_reapply_rules(p_issue_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.system_issues;
  v_rule public.system_issue_rules;
  v_base text;
  v_sev text;
  v_subsys text;
  v_title text;
  v_status text;
  v_n integer := 0;
begin
  for r in
    select * from public.system_issues i
    where p_issue_ids is null or i.id = any (p_issue_ids)
    order by i.id
    for no key update of i
  loop
    begin
      v_rule := public._system_pick_rule(r.source, r.operation, r.error_class, r.error_code);
      continue when v_rule.id is not null and v_rule.action = 'ignore';
      v_base := r.base_severity;
      if v_rule.id is not null then
        if public._system_sev_rank(v_rule.severity_floor) > public._system_sev_rank(v_base) then
          v_base := v_rule.severity_floor;
        end if;
        if public._system_sev_rank(v_rule.severity_cap) > 0
           and public._system_sev_rank(v_rule.severity_cap) < public._system_sev_rank(v_base) then
          v_base := v_rule.severity_cap;
        end if;
      end if;
      v_subsys := r.reported_subsystem;
      if v_rule.id is not null and v_rule.set_subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$' then
        v_subsys := v_rule.set_subsystem;
      end if;
      v_title := null;
      if v_rule.id is not null and v_rule.set_title is not null and char_length(v_rule.set_title) between 1 and 160 then
        v_title := v_rule.set_title;
      end if;
      v_title := coalesce(v_title, left(v_subsys || ': ' || r.operation || coalesce(' (' || r.error_code || ')', ''), 160));
      v_sev := case when r.severity = r.base_severity then v_base
                    else public._system_rank_sev(greatest(public._system_sev_rank(v_base), public._system_sev_rank(r.severity))) end;
      v_status := r.status;
      if v_rule.id is not null and v_rule.action = 'telemetry' and r.status <> 'muted' then
        insert into public.system_issue_transitions (issue_id, from_status, to_status, kind, actor_user_id)
        values (r.id, r.status, 'muted', 'mute', null);
        v_status := 'muted';
        v_sev := 'info';
        v_base := 'info';
      end if;
      update public.system_issues
      set subsystem = v_subsys, title = v_title, base_severity = v_base, severity = v_sev, status = v_status,
          impact = case when v_rule.impact in ('degraded', 'blocking', 'data_risk', 'financial_risk') then v_rule.impact else null end,
          rule_id = v_rule.id,
          resolution = case when v_status = 'muted' and r.status <> 'muted' then null else resolution end,
          muted_until = case when v_status = 'muted' and r.status <> 'muted' then null else muted_until end
      where id = r.id;
      v_n := v_n + 1;
    exception when others then
      raise warning 'system monitoring: rule re-apply skipped an issue (sqlstate %)', sqlstate;
    end;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges. Default grants hand EXECUTE to anon / authenticated / service_role on every new
-- function: strip them all, then grant the approved matrix only.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        '_system_ingest_impl', '_system_ingest', '_report_system_error', 'system_report_trusted',
        'report_client_error', 'system_issue_acknowledge', 'system_issue_resolve', 'system_issue_mute',
        'system_issue_unmute', 'system_issue_reopen', '_system_monitoring_maintenance', '_system_reapply_rules')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

grant execute on function public.report_client_error(jsonb) to authenticated;
grant execute on function public.system_report_trusted(jsonb) to service_role;
grant execute on function public.system_issue_acknowledge(uuid) to authenticated;
grant execute on function public.system_issue_resolve(uuid, text, timestamptz) to authenticated;
grant execute on function public.system_issue_mute(uuid, timestamptz) to authenticated;
grant execute on function public.system_issue_unmute(uuid) to authenticated;
grant execute on function public.system_issue_reopen(uuid) to authenticated;

comment on function public.report_client_error(jsonb) is
  'Untrusted authenticated client ingestion. Identity from auth.uid(); source/severity ceiling/subsystem/'
  'impact/lifecycle/rule/fingerprint decided server-side. Disabled via system_monitoring_config until the '
  'application is wired to it (Phase 5).';
comment on function public.system_report_trusted(jsonb) is
  'Trusted ingestion for service_role callers (Edge Functions). Not executable by any client role.';
comment on function public._system_monitoring_maintenance(timestamptz) is
  'Internal retention/auto-quiet maintenance. NOT scheduled in Phase 1.';

-- ---------------------------------------------------------------------------------------------
-- Final self-check of the complete privilege matrix. Aborts the migration on any deviation.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
  v_role text;
  v_auth boolean;
  v_svc boolean;
  v_n integer := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname, p.prosecdef, p.proconfig,
           pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like '\_system\_%' or p.proname like 'system\_%' or p.proname in ('report_client_error', '_report_system_error'))
  loop
    v_n := v_n + 1;
    if r.owner <> 'postgres' then
      raise exception 'self-check: % is not owned by postgres', r.sig;
    end if;
    if r.proconfig is null or not ('search_path=public, pg_temp' = any (r.proconfig)) then
      raise exception 'self-check: % does not pin search_path', r.sig;
    end if;
    foreach v_role in array array['public', 'anon'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        raise exception 'self-check: % is executable by %', r.sig, v_role;
      end if;
    end loop;
    v_auth := r.proname in ('system_monitoring_is_manager', 'report_client_error', 'system_issue_acknowledge',
                            'system_issue_resolve', 'system_issue_mute', 'system_issue_unmute', 'system_issue_reopen');
    v_svc := r.proname = 'system_report_trusted';
    if has_function_privilege('authenticated', r.oid, 'EXECUTE') <> v_auth then
      raise exception 'self-check: % has the wrong authenticated EXECUTE privilege', r.sig;
    end if;
    if has_function_privilege('service_role', r.oid, 'EXECUTE') <> v_svc then
      raise exception 'self-check: % has the wrong service_role EXECUTE privilege', r.sig;
    end if;
    -- Internal helpers are SECURITY INVOKER; every entry point / worker is SECURITY DEFINER.
    if r.proname in ('_system_sev_rank', '_system_rank_sev', '_system_cfg', '_system_limit', '_system_flag',
                     '_system_redact', '_system_normalize_template', '_system_sanitize_map', '_system_fingerprint',
                     '_system_pick_rule', '_system_pick_text', '_system_stack_origin', '_system_ret') then
      if r.prosecdef then raise exception 'self-check: helper % must be SECURITY INVOKER', r.sig; end if;
    else
      if not r.prosecdef then raise exception 'self-check: % must be SECURITY DEFINER', r.sig; end if;
    end if;
  end loop;
  -- 1 gate + 13 helpers + 12 entry/internal functions.
  if v_n <> 26 then
    raise exception 'self-check: expected 26 monitoring functions, found %', v_n;
  end if;
  if not exists (select 1 from public.system_monitoring_config where key = 'client_ingest_enabled' and value = 'false'::jsonb) then
    raise exception 'self-check: client_ingest_enabled must default to false';
  end if;
  if exists (select 1 from cron.job where command ilike '%system\_%' or jobname ilike '%system%monitor%') then
    raise exception 'self-check: no monitoring cron job may exist in Phase 1';
  end if;
end $$;
