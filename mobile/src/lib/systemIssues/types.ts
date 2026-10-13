/** Shapes of the monitoring rows the manager screen reads (column-level grants of Phase 1; no user ids, entities, stacks or routes). */
export type IssueStatus = "open" | "acknowledged" | "resolved" | "muted";
export type IssueSeverity = "info" | "warning" | "error" | "critical";

export interface SystemIssueRow {
  id: string;
  source: string;
  subsystem: string;
  operation: string;
  error_class: string | null;
  error_code: string | null;
  title: string;
  latest_summary: string;
  severity: IssueSeverity;
  base_severity: IssueSeverity;
  impact: string | null;
  status: IssueStatus;
  resolution: string | null;
  muted_until: string | null;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  reopen_count: number;
  reopened_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  first_seen_version: string | null;
  last_seen_version: string | null;
  regressed_in_version: string | null;
}

export interface IssueEventRow {
  id: string;
  occurred_at: string;
  severity: IssueSeverity;
  app_version: string | null;
  build: string | null;
  platform: string | null;
  env: string | null;
  user_role: string | null;
  message: string | null;
  context: Record<string, unknown> | null;
  sample_reason: string;
  coalesced_count: number;
}

export interface IssueTransitionRow {
  id: number | string;
  at: string;
  from_status: string | null;
  to_status: string;
  kind: string;
  reason: string | null;
}

export interface IssueBucketRow {
  bucket_start: string;
  count: number;
}

export type StatusFilter = "active" | "all" | "open" | "acknowledged" | "muted" | "resolved";
export type SeverityFilter = "all" | IssueSeverity;
export type SourceFilter = "all" | "cron" | "client" | "db" | "edge" | "other";
export type RecencyFilter = "all" | "24h" | "7d" | "30d";
export type SortKey = "recent" | "severe" | "frequent";

export interface IssueFilters {
  status: StatusFilter;
  severity: SeverityFilter;
  source: SourceFilter;
  recency: RecencyFilter;
}

export const DEFAULT_FILTERS: IssueFilters = { status: "active", severity: "all", source: "all", recency: "all" };
export const PAGE_SIZE = 20;

export interface IssueSummary {
  open: number;
  acknowledged: number;
  muted: number;
  reopened: number;
  recent: number;
}

export type ActionResult = { ok: true; status: string } | { ok: false; error: string; status?: string };
