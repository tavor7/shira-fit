-- System monitoring, Phase 1 (1/3): storage, configuration and the security foundation.
--
-- A general-purpose TECHNICAL monitoring store for Shira Fit: aggregated issues, sampled occurrence
-- events, hourly counters, an append-only lifecycle audit, developer-controlled classification rules,
-- developer-controlled configuration and per-user abuse quotas. This migration only creates storage and
-- the one authorization helper the RLS policies need. Ingestion / lifecycle functions come in the next
-- two migrations. NOTHING in the existing application reads or writes these objects, no cron job is
-- created and no existing object is altered.
--
-- Security model (hard requirements):
--   * Default privileges in this project grant ALL on new tables (and EXECUTE on new functions) to anon,
--     authenticated and service_role. Every object created here therefore starts with an explicit
--     REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role, followed by the minimum grants.
--   * Managers (profiles.role = 'manager' AND disabled_at IS NULL) may READ the four data tables through
--     RLS plus column-level SELECT grants. No client role may INSERT/UPDATE/DELETE any monitoring row;
--     lifecycle changes go through narrow SECURITY DEFINER RPCs (migration 3).
--   * Rules, configuration and quotas have no client access at all (not even SELECT).
--   * is_super_user is NOT part of this model, and the arbitrary-uid is_manager(uid) is not reused.
--
-- Persistence note: a monitoring row written from inside PostgreSQL is durable only if the OUTER
-- transaction commits. There are no autonomous transactions and no dblink here by design.

-- ---------------------------------------------------------------------------------------------
-- Authorization helper (needed by the RLS policies below).
-- Zero-argument on purpose: it can only answer for the CALLER (no uid probing). A manager whose
-- account is disabled keeps a valid JWT (staff_set_account_disabled does not ban the auth user), so
-- disabled_at is checked explicitly.
-- ---------------------------------------------------------------------------------------------
create or replace function public.system_monitoring_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'manager'
      and p.disabled_at is null
  );
$$;

revoke all on function public.system_monitoring_is_manager() from public, anon, authenticated, service_role;
grant execute on function public.system_monitoring_is_manager() to authenticated;

comment on function public.system_monitoring_is_manager() is
  'Authorization gate for the technical monitoring system: the CALLER is an authenticated, non-disabled '
  'manager. Zero arguments (cannot probe other users). Deliberately independent of is_super_user and of '
  'is_manager(uid).';

-- ---------------------------------------------------------------------------------------------
-- system_monitoring_config: developer-controlled configuration (kill switches, limits, retention,
-- context allowlist). Not app_kv_settings: managers can write that table directly.
-- ---------------------------------------------------------------------------------------------
create table public.system_monitoring_config (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- system_issue_rules: minimal classification rules (exact match; trailing '*' prefix on operation only;
-- no regex, no message matching, no dynamic SQL). Developer-controlled data.
-- ---------------------------------------------------------------------------------------------
create table public.system_issue_rules (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default true,
  priority integer not null default 0,
  match_source text check (match_source ~ '^[a-z][a-z0-9_]{1,31}$'),
  match_operation text check (match_operation ~ '^[A-Za-z0-9_./:-]{1,120}\*?$'),
  match_error_class text check (match_error_class ~ '^[A-Za-z0-9_.$-]{1,80}$'),
  match_error_code text check (match_error_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  action text not null default 'classify' check (action in ('classify', 'ignore', 'telemetry')),
  set_subsystem text check (set_subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$'),
  set_title text check (char_length(set_title) between 1 and 160),
  severity_floor text check (severity_floor in ('info', 'warning', 'error', 'critical')),
  severity_cap text check (severity_cap in ('info', 'warning', 'error', 'critical')),
  impact text check (impact in ('degraded', 'blocking', 'data_risk', 'financial_risk')),
  quiet_resolve_hours integer check (quiet_resolve_hours between 1 and 2160),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A rule must match on something: a catch-all rule could silence or reclassify everything.
  constraint system_issue_rules_has_match check (
    match_source is not null or match_operation is not null
    or match_error_class is not null or match_error_code is not null
  ),
  -- 'ignore' drops reports entirely, so it must be anchored to an operation or an error code.
  constraint system_issue_rules_ignore_anchored check (
    action <> 'ignore' or match_operation is not null or match_error_code is not null
  ),
  constraint system_issue_rules_floor_le_cap check (
    severity_floor is null or severity_cap is null
    or (case severity_floor when 'info' then 1 when 'warning' then 2 when 'error' then 3 else 4 end)
       <= (case severity_cap when 'info' then 1 when 'warning' then 2 when 'error' then 3 else 4 end)
  )
);

create index system_issue_rules_enabled_priority_idx
  on public.system_issue_rules (enabled, priority desc);

-- ---------------------------------------------------------------------------------------------
-- system_issues: one row per fingerprint for its whole life.
-- fillfactor 70 and NO index on last_seen / occurrence_count so ingestion updates can be HOT.
-- ---------------------------------------------------------------------------------------------
create table public.system_issues (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique check (fingerprint ~ '^[0-9a-f]{32}$'),
  source text not null check (source ~ '^[a-z][a-z0-9_]{1,31}$'),
  reported_subsystem text not null default 'unclassified' check (reported_subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$'),
  subsystem text not null default 'unclassified' check (subsystem ~ '^[a-z][a-z0-9_.-]{0,47}$'),
  operation text not null check (operation ~ '^[A-Za-z0-9_./:-]{1,120}$'),
  error_class text check (error_class ~ '^[A-Za-z0-9_.$-]{1,80}$'),
  error_code text check (error_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  title text not null check (char_length(title) between 1 and 160),
  latest_summary text not null check (char_length(latest_summary) <= 300),
  base_severity text not null check (base_severity in ('info', 'warning', 'error', 'critical')),
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  impact text check (impact in ('degraded', 'blocking', 'data_risk', 'financial_risk')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'muted')),
  resolution text check (resolution in ('auto_recovered', 'auto_quiet', 'manual_fixed', 'manual_expected')),
  muted_until timestamptz,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  occurrence_count bigint not null default 1 check (occurrence_count >= 1),
  reopen_count integer not null default 0 check (reopen_count >= 0),
  reopened_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  first_seen_version text check (first_seen_version ~ '^[A-Za-z0-9._+-]{1,32}$'),
  last_seen_version text check (last_seen_version ~ '^[A-Za-z0-9._+-]{1,32}$'),
  resolved_version text check (resolved_version ~ '^[A-Za-z0-9._+-]{1,32}$'),
  regressed_in_version text check (regressed_in_version ~ '^[A-Za-z0-9._+-]{1,32}$'),
  rule_id uuid references public.system_issue_rules (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint system_issues_resolved_has_time check (status <> 'resolved' or resolved_at is not null)
) with (fillfactor = 70);

create index system_issues_active_idx
  on public.system_issues (status) where status in ('open', 'acknowledged');
create index system_issues_resolved_at_idx
  on public.system_issues (resolved_at) where status = 'resolved';

-- ---------------------------------------------------------------------------------------------
-- system_issue_events: sampled occurrences (hard-capped per issue; first occurrence kept).
-- Only sanitized / allowlisted data is ever written here (see helper functions).
-- ---------------------------------------------------------------------------------------------
create table public.system_issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.system_issues (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  app_version text check (app_version ~ '^[A-Za-z0-9._+-]{1,32}$'),
  build text check (build ~ '^[A-Za-z0-9._+-]{1,32}$'),
  platform text check (platform in ('ios', 'android', 'web', 'server')),
  env text check (env ~ '^[a-z]{2,16}$'),
  route text check (char_length(route) <= 120),
  user_id uuid,
  user_role text check (user_role in ('athlete', 'coach', 'manager')),
  entities jsonb not null default '{}'::jsonb check (jsonb_typeof(entities) = 'object'),
  message text check (char_length(message) <= 500),
  stack text check (char_length(stack) <= 2000),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  sample_reason text not null check (sample_reason in ('first', 'sampled', 'escalation', 'critical')),
  coalesced_count integer not null default 1 check (coalesced_count >= 1)
);

create index system_issue_events_issue_idx on public.system_issue_events (issue_id, occurred_at desc);
create index system_issue_events_occurred_idx on public.system_issue_events (occurred_at);

-- ---------------------------------------------------------------------------------------------
-- system_issue_buckets: hourly counters ("is it still happening", escalation, flood breaker).
-- ---------------------------------------------------------------------------------------------
create table public.system_issue_buckets (
  issue_id uuid not null references public.system_issues (id) on delete cascade,
  bucket_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  sampled integer not null default 0 check (sampled >= 0),
  breaker_tripped_at timestamptz,
  primary key (issue_id, bucket_start)
) with (fillfactor = 70);

create index system_issue_buckets_start_idx on public.system_issue_buckets (bucket_start);

-- ---------------------------------------------------------------------------------------------
-- system_issue_transitions: append-only lifecycle audit (who / when / from / to).
-- ---------------------------------------------------------------------------------------------
create table public.system_issue_transitions (
  id bigint generated always as identity primary key,
  issue_id uuid not null references public.system_issues (id) on delete cascade,
  at timestamptz not null default now(),
  from_status text check (from_status in ('open', 'acknowledged', 'resolved', 'muted')),
  to_status text not null check (to_status in ('open', 'acknowledged', 'resolved', 'muted')),
  kind text not null check (kind in (
    'create', 'ack', 'resolve', 'mute', 'unmute', 'reopen',
    'auto_reopen', 'auto_resolve', 'auto_unmute', 'escalate'
  )),
  actor_user_id uuid,
  reason text check (reason in ('auto_recovered', 'auto_quiet', 'manual_fixed', 'manual_expected'))
);

create index system_issue_transitions_issue_idx on public.system_issue_transitions (issue_id, at);

-- ---------------------------------------------------------------------------------------------
-- system_report_quota: per-user (and global pseudo-user) hourly abuse limits for ingestion.
-- No FK to auth.users on purpose (pseudo-user rows; no cascade cost).
-- ---------------------------------------------------------------------------------------------
create table public.system_report_quota (
  user_id uuid not null,
  bucket_start timestamptz not null,
  reports integer not null default 0 check (reports >= 0),
  new_fingerprints integer not null default 0 check (new_fingerprints >= 0),
  primary key (user_id, bucket_start)
) with (fillfactor = 70);

create index system_report_quota_start_idx on public.system_report_quota (bucket_start);

-- ---------------------------------------------------------------------------------------------
-- Privileges: strip every default grant first, then grant the minimum.
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.system_monitoring_config,
  public.system_issue_rules,
  public.system_issues,
  public.system_issue_events,
  public.system_issue_buckets,
  public.system_issue_transitions,
  public.system_report_quota
from public, anon, authenticated, service_role;

alter table public.system_monitoring_config enable row level security;
alter table public.system_issue_rules enable row level security;
alter table public.system_issues enable row level security;
alter table public.system_issue_events enable row level security;
alter table public.system_issue_buckets enable row level security;
alter table public.system_issue_transitions enable row level security;
alter table public.system_report_quota enable row level security;

-- Managers read the four data tables. Column-level grants (every current column) so that a column
-- added by a future migration is NOT readable until it is deliberately granted.
grant select (
  id, fingerprint, source, reported_subsystem, subsystem, operation, error_class, error_code, title,
  latest_summary, base_severity, severity, impact, status, resolution, muted_until, first_seen, last_seen,
  occurrence_count, reopen_count, reopened_at, acknowledged_at, acknowledged_by, resolved_at, resolved_by,
  first_seen_version, last_seen_version, resolved_version, regressed_in_version, rule_id, created_at
) on public.system_issues to authenticated;

grant select (
  id, issue_id, occurred_at, severity, app_version, build, platform, env, route, user_id, user_role,
  entities, message, stack, context, sample_reason, coalesced_count
) on public.system_issue_events to authenticated;

grant select (issue_id, bucket_start, count, sampled, breaker_tripped_at)
  on public.system_issue_buckets to authenticated;

grant select (id, issue_id, at, from_status, to_status, kind, actor_user_id, reason)
  on public.system_issue_transitions to authenticated;

create policy system_issues_manager_select on public.system_issues
  for select to authenticated
  using ((select public.system_monitoring_is_manager()));

create policy system_issue_events_manager_select on public.system_issue_events
  for select to authenticated
  using ((select public.system_monitoring_is_manager()));

create policy system_issue_buckets_manager_select on public.system_issue_buckets
  for select to authenticated
  using ((select public.system_monitoring_is_manager()));

create policy system_issue_transitions_manager_select on public.system_issue_transitions
  for select to authenticated
  using ((select public.system_monitoring_is_manager()));

-- No policies on rules / config / quota: with RLS enabled and no grants, no client role can touch them.

-- ---------------------------------------------------------------------------------------------
-- Seed configuration (developer-controlled; changeable without a schema migration, but only through
-- service-role / owner SQL: no client role can read or write this table).
-- ---------------------------------------------------------------------------------------------
insert into public.system_monitoring_config (key, value) values
  ('ingest_enabled', 'true'::jsonb),
  ('client_ingest_enabled', 'false'::jsonb),
  ('limits', jsonb_build_object(
    'breaker_per_hour', 1000,
    'events_per_issue_per_hour', 5,
    'max_events_per_issue', 50,
    'user_reports_per_hour', 20,
    'user_new_fingerprints_per_hour', 5,
    'client_new_issues_per_hour', 100,
    'trusted_new_issues_per_hour', 500,
    'max_payload_bytes_client', 16384,
    'max_payload_bytes_trusted', 65536,
    'escalate_warning_to_error_per_hour', 10,
    'flap_window_days', 30,
    'flap_reopens', 3,
    'escalation_decay_hours', 24
  )),
  ('retention', jsonb_build_object(
    'events_days', jsonb_build_object('info', 30, 'warning', 30, 'error', 90, 'critical', 180),
    'buckets_days', 60,
    'resolved_issue_days', jsonb_build_object('info', 90, 'warning', 90, 'error', 365, 'critical', 730),
    'quota_hours', 48,
    'quiet_resolve_hours', jsonb_build_object('info', 24, 'warning', 24, 'error', 168)
  )),
  ('context_allowed_keys', jsonb_build_object(
    'entities', jsonb_build_object(
      'session_id', 'uuid', 'series_id', 'uuid', 'occurrence_id', 'uuid', 'subscription_id', 'uuid',
      'billing_period_id', 'uuid', 'document_id', 'uuid', 'registration_id', 'uuid',
      'manual_participant_id', 'uuid', 'delivery_id', 'uuid'
    ),
    'context', jsonb_build_object(
      'http_status', 'int', 'provider', 'enum', 'provider_code', 'code', 'rpc', 'name', 'fn', 'name',
      'edge_function', 'name', 'job', 'name', 'attempt', 'int', 'duration_ms', 'int', 'count', 'int',
      'retryable', 'bool', 'network_state', 'enum', 'phase', 'enum', 'outcome', 'enum', 'sqlstate', 'code',
      'constraint', 'name', 'table', 'name', 'reason', 'enum'
    )
  ));

comment on table public.system_monitoring_config is
  'Developer-controlled monitoring configuration (kill switches, limits, retention, context allowlist). '
  'No client role has any privilege on this table.';
comment on table public.system_issue_rules is
  'Developer-controlled classification rules for monitoring issues. No client role has any privilege.';
comment on table public.system_issues is
  'Aggregated technical issues (one row per server-computed fingerprint). Managers read; all writes go '
  'through SECURITY DEFINER functions.';
comment on table public.system_issue_events is
  'Sampled, sanitized occurrences of a system issue (hard-capped per issue).';
comment on table public.system_issue_buckets is 'Hourly occurrence counters per issue (flood breaker + recency).';
comment on table public.system_issue_transitions is 'Append-only lifecycle audit of system issues.';
comment on table public.system_report_quota is
  'Hourly per-user / global ingestion quotas. No client role has any privilege.';

-- ---------------------------------------------------------------------------------------------
-- Self-check: abort the migration if the final privilege state is not exactly the intended one.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_t text;
  v_role text;
  v_data constant text[] := array[
    'system_issues', 'system_issue_events', 'system_issue_buckets', 'system_issue_transitions'
  ];
  v_closed constant text[] := array[
    'system_monitoring_config', 'system_issue_rules', 'system_report_quota'
  ];
begin
  foreach v_t in array v_data || v_closed loop
    if pg_get_userbyid((select relowner from pg_class where oid = ('public.' || v_t)::regclass)) <> 'postgres' then
      raise exception 'self-check: public.% is not owned by postgres', v_t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_t)::regclass) then
      raise exception 'self-check: RLS is not enabled on public.%', v_t;
    end if;
    foreach v_role in array array['anon', 'service_role'] loop
      if has_any_column_privilege(v_role, ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege(v_role, ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'self-check: % has a privilege on public.%', v_role, v_t;
      end if;
    end loop;
    if has_table_privilege('authenticated', ('public.' || v_t)::regclass, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT')
       or has_any_column_privilege('authenticated', ('public.' || v_t)::regclass, 'INSERT,UPDATE,REFERENCES') then
      raise exception 'self-check: authenticated has a table-level or write privilege on public.%', v_t;
    end if;
  end loop;

  foreach v_t in array v_closed loop
    if has_any_column_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT') then
      raise exception 'self-check: authenticated can read closed table public.%', v_t;
    end if;
  end loop;
  foreach v_t in array v_data loop
    if not has_any_column_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT') then
      raise exception 'self-check: authenticated cannot read public.%', v_t;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.system_monitoring_is_manager()', 'EXECUTE')
     or has_function_privilege('public', 'public.system_monitoring_is_manager()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.system_monitoring_is_manager()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.system_monitoring_is_manager()', 'EXECUTE') then
    raise exception 'self-check: system_monitoring_is_manager() has the wrong EXECUTE privileges';
  end if;
end $$;
