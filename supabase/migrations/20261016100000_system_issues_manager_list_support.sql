-- Manager "System issues" screen (Phase 4A): list ordering support. FORWARD-ONLY, no data change, no function change.
--
-- The manager UI reads system_issues directly (RLS: managers only; column-level SELECT grants from Phase 1) and pages it on the
-- server. "Most severe first" needs a numeric severity: ordering the text column would give warning > info > error > critical.
-- A generated column keeps the rank in step with `severity` without touching any ingestion or lifecycle code (every INSERT/UPDATE
-- of system_issues names its columns, so a generated column is invisible to them).
--
--   * severity_rank   smallint GENERATED ALWAYS AS (...) STORED   -- critical 4, error 3, warning 2, info 1
--   * SELECT on severity_rank for `authenticated` only (rows are still gated by the manager RLS policy)
--   * indexes for the three list orderings (recent / severe / frequent)
--
-- No client role gains any write privilege; no policy changes; client ingestion, monitoring configuration, rules, quotas, cron and
-- Phase 2.4 are untouched.

alter table public.system_issues
  add column if not exists severity_rank smallint
  generated always as (
    case severity when 'critical' then 4 when 'error' then 3 when 'warning' then 2 when 'info' then 1 else 0 end
  ) stored;

grant select (severity_rank) on public.system_issues to authenticated;

create index if not exists system_issues_last_seen_idx on public.system_issues (last_seen desc);
create index if not exists system_issues_severity_rank_idx on public.system_issues (severity_rank desc, last_seen desc);
create index if not exists system_issues_occurrence_idx on public.system_issues (occurrence_count desc, last_seen desc);

comment on column public.system_issues.severity_rank is
  'critical 4, error 3, warning 2, info 1 (generated from severity). Exists so the manager UI can order by severity on the server.';

do $$
begin
  if has_column_privilege('anon', 'public.system_issues', 'severity_rank', 'SELECT')
     or has_column_privilege('service_role', 'public.system_issues', 'severity_rank', 'SELECT')
     or has_column_privilege('authenticated', 'public.system_issues', 'severity_rank', 'INSERT,UPDATE') then
    raise exception 'self-check: severity_rank has an unexpected privilege';
  end if;
  if not has_column_privilege('authenticated', 'public.system_issues', 'severity_rank', 'SELECT') then
    raise exception 'self-check: authenticated cannot read severity_rank';
  end if;
end $$;
