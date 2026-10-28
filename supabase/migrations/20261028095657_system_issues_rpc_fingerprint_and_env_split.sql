-- System monitoring: split RPC-postgrest issues by the real RPC name, and separate production from
-- development occurrence counts. Follows a read-only investigation of two open System Issues warnings
-- (ids 4b90c582-d1d2-4314-9d02-74beadae404b, feebaf44-1671-4c71-ae8b-0dd21f0051c5) that found:
--   (a) both are already resolved/non-reproducible (resolved via the existing workflow, see application code --
--       not this migration), and
--   (b) one of them was actually two *unrelated* RPCs (get_subscription_weekly_usage, manager_get_archive_health)
--       merged into a single issue, because the fingerprint uses the fixed literal operation 'rpc/postgrest' for
--       every client RPC/Postgrest error -- the real RPC name only ever lands in event-level context.rpc, which
--       is not a fingerprint input (see 20261015100000_system_monitoring_client_allowlist.sql line 18).
--
-- Four things were specifically verified against the live database before writing this migration (do not
-- re-derive these from first principles -- they were checked, not assumed):
--   1. _system_fingerprint's live identity signature is (text,text,text,text,text,text,text,text) -- 8 params.
--      CREATE OR REPLACE only replaces a function in place when the identity argument list is unchanged; adding
--      a 9th parameter would silently create a SECOND OVERLOAD under the same name, not a safe replace. So this
--      migration does NOT touch _system_fingerprint at all -- new function below instead, own name, own body.
--      _system_ingest_impl's own identity signature, (text,jsonb,uuid), is unchanged by this migration, so its
--      CREATE OR REPLACE below is a true in-place replace with no overload risk.
--   2. system_issue_events is sampled (events_per_issue_per_hour, default 5) and hard-capped per issue
--      (max_events_per_issue, default 50, evicted FIFO inline on every ingest -- independent of the maintenance
--      cron, which is confirmed NOT scheduled in production: no cron.job row calls it). So count(*) from
--      system_issue_events is a provable lower bound, not a guaranteed-exact total, for any issue that ever
--      exceeded those caps. Checked every row that exists today: all 4 have occurrence_count = stored event
--      count (gap = 0) -- so today's backfill is exact, but the schema still records whether that remains true
--      per issue (env_history_complete), rather than silently assuming it always will.
--   3. A mixed-environment issue must be able to show up under both a "production" and a "development" view with
--      its own correct count AND its own correct last-seen timestamp for each -- a derived subtraction can give a
--      count but not a timestamp, so both environments get their own first/last-seen columns, not just a shared
--      total split two ways.
--   4. No existing system_issues.id, fingerprint, system_issue_events row, system_issue_transitions row, or
--      system_issue_push_outbox/system_push_idempotency_keys row is rewritten or reinterpreted here. Every change
--      below is either a new, independently-nullable column or a new, separately-named function.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. New helper, NOT an overload of _system_fingerprint (different name, so no ambiguity is possible). Same hash
--    shape, with one extra field. concat_ws() ignores NULL arguments, so calling this with p_detail = null
--    produces the exact same md5 input (and therefore the exact same fingerprint) as the untouched
--    _system_fingerprint would for the same other 7 fields -- this is what keeps every non-RPC-named report
--    (cron, db, edge, trusted, or any rpc/postgrest report where context.rpc was absent/invalid) byte-for-byte
--    unaffected. p_detail must already be a validated, bounded identifier (the caller passes the same sanitized
--    RPC name that would otherwise only appear in context.rpc) -- never raw user/message text.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._system_fingerprint_rpc_detail(
  p_source text,
  p_subsystem text,
  p_operation text,
  p_error_class text,
  p_error_code text,
  p_template text,
  p_origin text,
  p_detail text,
  p_key text default null
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key is not null then md5('key' || chr(31) || p_key)
    else md5(concat_ws(chr(31),
      coalesce(p_source, ''), coalesce(p_subsystem, ''), coalesce(p_operation, ''),
      coalesce(p_error_class, ''), coalesce(p_error_code, ''), coalesce(p_template, ''), coalesce(p_origin, ''),
      p_detail))
  end;
$$;

comment on function public._system_fingerprint_rpc_detail(text, text, text, text, text, text, text, text, text) is
  'Like _system_fingerprint, plus one optional sanitized detail field (the real RPC name for rpc/postgrest '
  'reports) folded into the hash. A separate function, not an overload: _system_fingerprint keeps its original '
  '8-parameter signature untouched everywhere else. NULL p_detail hashes identically to the original formula '
  '(concat_ws skips NULL arguments).';

revoke all on function public._system_fingerprint_rpc_detail(text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. New columns on system_issues. All nullable except env_history_complete (default true: a freshly created
--    issue is always exactly known at creation; historical rows get this recomputed by the backfill below).
--    "dev" below means "any environment other than prod" (the manager dashboard's binary Production/Development
--    split); prod_* and dev_* are symmetric so each has its own count AND its own first/last-seen timestamp --
--    deliberately NOT just occurrence_count minus prod_occurrence_count, which could give a count but never a
--    timestamp for the non-prod side.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.system_issues
  add column if not exists operation_label text,
  add column if not exists env_history_complete boolean not null default true,
  add column if not exists prod_occurrence_count bigint,
  add column if not exists prod_first_seen timestamptz,
  add column if not exists prod_last_seen timestamptz,
  add column if not exists dev_occurrence_count bigint,
  add column if not exists dev_first_seen timestamptz,
  add column if not exists dev_last_seen timestamptz;

alter table public.system_issues drop constraint if exists system_issues_operation_label_shape;
alter table public.system_issues add constraint system_issues_operation_label_shape
  check (operation_label is null or operation_label ~ '^[A-Za-z0-9_./:-]{1,80}$');

alter table public.system_issues drop constraint if exists system_issues_prod_occurrence_count_nonneg;
alter table public.system_issues add constraint system_issues_prod_occurrence_count_nonneg
  check (prod_occurrence_count is null or prod_occurrence_count >= 0);
alter table public.system_issues drop constraint if exists system_issues_dev_occurrence_count_nonneg;
alter table public.system_issues add constraint system_issues_dev_occurrence_count_nonneg
  check (dev_occurrence_count is null or dev_occurrence_count >= 0);

alter table public.system_issues add column if not exists has_dev_occurrence boolean
  generated always as (coalesce(dev_occurrence_count, 0) > 0) stored;

comment on column public.system_issues.operation_label is
  'Sanitized real RPC name for an rpc/postgrest issue (same validated value that already lives in each event''s '
  'context.rpc), used only to make the manager-facing title specific. Null for every other operation family, and '
  'for rpc/postgrest issues reported before this column existed or where context.rpc was absent/invalid.';
comment on column public.system_issues.env_history_complete is
  'FALSE means this issue, at some point before this flag was last computed, had more occurrences than stored '
  'events (sampling/eviction dropped some), or an occurrence with an unknown env -- so prod_*/dev_* below are a '
  'floor for that portion of its history, not an exact historical total. Never flips back to TRUE. Every '
  'occurrence from the point this migration deployed onward is always counted exactly regardless of this flag.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. One-time backfill from the (currently fully intact) event history. Per issue: exact only when every
--    occurrence has a matching stored event AND every stored event has a known env; otherwise honestly marked
--    incomplete rather than presented as exact.
-- ---------------------------------------------------------------------------------------------------------------
with agg as (
  select
    e.issue_id,
    count(*) as stored_events,
    count(*) filter (where e.env is null) as unknown_env_events,
    count(*) filter (where e.env = 'prod') as prod_n,
    min(e.occurred_at) filter (where e.env = 'prod') as prod_min,
    max(e.occurred_at) filter (where e.env = 'prod') as prod_max,
    count(*) filter (where e.env is not null and e.env <> 'prod') as dev_n,
    min(e.occurred_at) filter (where e.env is not null and e.env <> 'prod') as dev_min,
    max(e.occurred_at) filter (where e.env is not null and e.env <> 'prod') as dev_max
  from public.system_issue_events e
  group by e.issue_id
)
update public.system_issues i set
  env_history_complete = (agg.stored_events = i.occurrence_count and agg.unknown_env_events = 0),
  prod_occurrence_count = agg.prod_n,
  prod_first_seen = agg.prod_min,
  prod_last_seen = agg.prod_max,
  dev_occurrence_count = agg.dev_n,
  dev_first_seen = agg.dev_min,
  dev_last_seen = agg.dev_max
from agg
where agg.issue_id = i.id;

-- Issues with zero stored events (should not currently exist, but handled honestly rather than left as NULL
-- looking like "zero occurrences" if one ever does): mark incomplete, both counts unknown (left null).
update public.system_issues i
set env_history_complete = false
where not exists (select 1 from public.system_issue_events e where e.issue_id = i.id);

-- Self-check: every issue marked complete must have its prod+dev counts add up to its occurrence_count exactly.
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.system_issues
  where env_history_complete
    and coalesce(prod_occurrence_count, 0) + coalesce(dev_occurrence_count, 0) <> occurrence_count;
  if v_bad > 0 then
    raise exception 'self-check: % issue(s) marked env_history_complete with a prod+dev count that does not equal occurrence_count', v_bad;
  end if;
end $$;

grant select (
  operation_label, env_history_complete,
  prod_occurrence_count, prod_first_seen, prod_last_seen,
  dev_occurrence_count, dev_first_seen, dev_last_seen,
  has_dev_occurrence
) on public.system_issues to authenticated;

create index if not exists system_issues_prod_last_seen_idx
  on public.system_issues (prod_last_seen desc)
  where coalesce(prod_occurrence_count, 0) > 0;
create index if not exists system_issues_dev_last_seen_idx
  on public.system_issues (dev_last_seen desc)
  where has_dev_occurrence;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. _system_ingest_impl: same identity signature (text, jsonb, uuid), so this is a true in-place replace, not a
--    new overload. Every line below is byte-for-byte identical to the live function
--    (20261015100000_system_monitoring_client_allowlist.sql) EXCEPT the ones marked "-- NEW" / "-- CHANGED".
-- ---------------------------------------------------------------------------------------------------------------
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
  v_env_known boolean;
  v_rpc_name text; -- NEW: sanitized real RPC name for rpc/postgrest reports, extracted early (fingerprint needs it before v_context is built)
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

  -- NEW: sanitized real RPC name, only for the generic rpc/postgrest family, extracted straight from the raw
  -- payload (the full v_context sanitization below only runs when v_need_detail -- this must work for every
  -- report, sampled or not, since it feeds the fingerprint). Reuses the exact pattern _system_sanitize_map
  -- already applies to context.rpc ('name' type), so this is not a new trust boundary -- it is the same
  -- validated shape, just read one step earlier. _system_pick_text safely returns null for any wrong type/shape.
  v_rpc_name := case when v_op = 'rpc/postgrest'
    then public._system_pick_text(p_payload -> 'context' -> 'rpc', '^[A-Za-z0-9_./:-]{1,80}$')
    else null end;

  -- ---- fingerprint (server-side only; a client-supplied fingerprint is never read) ----
  -- CHANGED: only the rpc/postgrest + known-RPC-name path uses the new helper; every other report keeps calling
  -- the original, untouched _system_fingerprint exactly as before.
  if v_rpc_name is not null then
    v_fp := public._system_fingerprint_rpc_detail(v_source, v_subsys, v_op, v_class, v_code, v_template, v_origin, v_rpc_name, v_key);
  else
    v_fp := public._system_fingerprint(v_source, v_subsys, v_op, v_class, v_code, v_template, v_origin, v_key);
  end if;

  -- ---- classification ----
  begin
    if p_trust = 'client' and v_require_rule then
      -- Phase 3E.2 DEFAULT DENY: only an enabled rule flagged authorizes_client whose source/operation/class/code
      -- are exactly this report's (the table constraint forbids wildcards on such rules) lets a client report in.
      -- Wildcard / presentation rules never authorize anything. NOTE: matching is still on v_op ('rpc/postgrest'),
      -- never on v_rpc_name -- the allowlist's authorization surface is completely unchanged by this migration.
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
  v_env_known := (v_env is not null); -- NEW
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
  -- CHANGED: a known real RPC name is always more specific than any generic title, including an allowlist
  -- rule's static set_title (every rpc/postgrest allowlist seed row has one, e.g. "RPC database error:
  -- PGRST202" -- exactly the generic text this fix exists to replace, shared by every RPC that happens to
  -- fail with that code). This only ever overrides the TITLE string; severity/impact/subsystem stay
  -- entirely rule-driven as before, and v_op (fingerprint/authorization matching) is untouched.
  if v_rpc_name is not null then
    v_title := left(coalesce(v_subsys_eff, '') || ': ' || v_rpc_name || coalesce(' (' || v_code || ')', ''), 160);
  end if;
  v_title := coalesce(v_title, left(v_subsys_eff || ': ' || v_op || coalesce(' (' || v_code || ')', ''), 160));

  -- ---- create the issue (first report of this fingerprint) ----
  if v_issue_id is null then
    v_need_detail := true;
    for v_try in 1..3 loop
      insert into public.system_issues (
        fingerprint, source, reported_subsystem, subsystem, operation, error_class, error_code, title,
        latest_summary, base_severity, severity, impact, status, first_seen, last_seen, occurrence_count,
        first_seen_version, last_seen_version, rule_id,
        operation_label, env_history_complete, -- NEW
        prod_occurrence_count, prod_first_seen, prod_last_seen, -- NEW
        dev_occurrence_count, dev_first_seen, dev_last_seen -- NEW
      ) values (
        v_fp, v_source, v_subsys, v_subsys_eff, v_op, v_class, v_code, v_title,
        case when v_summary = '' then left(v_title, 300) else v_summary end, v_base, v_base, v_impact,
        case when v_telemetry then 'muted' else 'open' end, v_now, v_now, v_count,
        v_version, v_version, v_rule.id,
        v_rpc_name, v_env_known, -- NEW: a freshly created issue is exactly known iff this first occurrence's env is known
        case when v_env_known and v_env = 'prod' then v_count else 0 end, -- NEW
        case when v_env_known and v_env = 'prod' then v_now else null end, -- NEW
        case when v_env_known and v_env = 'prod' then v_now else null end, -- NEW
        case when v_env_known and v_env <> 'prod' then v_count else 0 end, -- NEW
        case when v_env_known and v_env <> 'prod' then v_now else null end, -- NEW
        case when v_env_known and v_env <> 'prod' then v_now else null end -- NEW
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
      rule_id = v_rule.id,
      operation_label = coalesce(v_rpc_name, operation_label), -- NEW: sticky -- a later occurrence missing context.rpc never blanks a name we already have
      env_history_complete = env_history_complete and v_env_known, -- NEW: sticky-false, never flips back to true
      prod_occurrence_count = coalesce(prod_occurrence_count, 0) + (case when v_env_known and v_env = 'prod' then v_count else 0 end), -- NEW
      prod_first_seen = coalesce(prod_first_seen, case when v_env_known and v_env = 'prod' then v_now else null end), -- NEW
      prod_last_seen = case when v_env_known and v_env = 'prod' then v_now else prod_last_seen end, -- NEW
      dev_occurrence_count = coalesce(dev_occurrence_count, 0) + (case when v_env_known and v_env <> 'prod' then v_count else 0 end), -- NEW
      dev_first_seen = coalesce(dev_first_seen, case when v_env_known and v_env <> 'prod' then v_now else null end), -- NEW
      dev_last_seen = case when v_env_known and v_env <> 'prod' then v_now else dev_last_seen end -- NEW
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

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Self-checks.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  -- Overload safety: _system_fingerprint must still be the single, original 8-arg function -- never duplicated.
  if (select count(*) from pg_proc where proname = '_system_fingerprint' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'self-check: _system_fingerprint must have exactly one overload';
  end if;
  if (select pg_get_function_identity_arguments(oid) from pg_proc
      where proname = '_system_fingerprint' and pronamespace = 'public'::regnamespace)
     <> 'p_source text, p_subsystem text, p_operation text, p_error_class text, p_error_code text, p_template text, p_origin text, p_key text' then
    raise exception 'self-check: _system_fingerprint signature changed unexpectedly';
  end if;
  -- The new helper must be internal-only, exactly like _system_fingerprint.
  if has_function_privilege('public', 'public._system_fingerprint_rpc_detail(text,text,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public._system_fingerprint_rpc_detail(text,text,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._system_fingerprint_rpc_detail(text,text,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public._system_fingerprint_rpc_detail(text,text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'self-check: _system_fingerprint_rpc_detail must be internal only';
  end if;
  -- _system_ingest_impl's own identity signature must be unchanged (true in-place replace, not a new overload).
  if (select count(*) from pg_proc where proname = '_system_ingest_impl' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'self-check: _system_ingest_impl must have exactly one overload';
  end if;
  -- Fingerprint stability: a report with no RPC detail must hash identically via either function.
  if public._system_fingerprint('client', 'database', 'rpc/postgrest', 'PostgrestError', '42883', '', '', null)
     <> public._system_fingerprint_rpc_detail('client', 'database', 'rpc/postgrest', 'PostgrestError', '42883', '', '', null, null) then
    raise exception 'self-check: null-detail fingerprint must match the original formula exactly';
  end if;
  -- Two different RPC names must fingerprint differently from each other and from the no-detail case.
  if public._system_fingerprint_rpc_detail('client', 'database', 'rpc/postgrest', 'PostgrestError', 'PGRST202', '', '', 'get_subscription_weekly_usage', null)
     = public._system_fingerprint_rpc_detail('client', 'database', 'rpc/postgrest', 'PostgrestError', 'PGRST202', '', '', 'manager_get_archive_health', null) then
    raise exception 'self-check: different RPC names must produce different fingerprints';
  end if;
  -- An explicit detector key still ignores every other field, p_detail included (unchanged legacy behaviour).
  if public._system_fingerprint(null, null, null, null, null, null, null, 'k')
     <> public._system_fingerprint_rpc_detail(null, null, null, null, null, null, null, 'anything', 'k') then
    raise exception 'self-check: explicit key path must still ignore all other fields including p_detail';
  end if;
end $$;
