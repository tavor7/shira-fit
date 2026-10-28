/**
 * Reads and actions for the manager System issues screen. Everything goes through the user's own authenticated client: the
 * Phase 1 RLS policies (managers only) and the SECURITY DEFINER lifecycle RPCs are the security boundary, not this file.
 * Reads are bounded: one page of issues (limit + 1 to learn whether there is more), at most 20 events / 100 transitions / 24 hourly
 * buckets per issue, five head-only counts for the dashboard. No unbounded history is ever fetched.
 */
import type { ActionResult, IssueBucketRow, IssueEventRow, IssueFilters, IssueSummary, IssueTransitionRow, SortKey, SystemIssueRow } from "./types";
import { PAGE_SIZE } from "./types";

// Structural client type: the real SupabaseClient satisfies it, tests pass a fake.
export type DbClient = { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export const ISSUE_COLUMNS =
  "id,source,subsystem,operation,error_class,error_code,title,latest_summary,severity,base_severity,impact,status,resolution,muted_until," +
  "first_seen,last_seen,occurrence_count,reopen_count,reopened_at,acknowledged_at,resolved_at,first_seen_version,last_seen_version,regressed_in_version," +
  "operation_label,env_history_complete,prod_occurrence_count,prod_last_seen,dev_occurrence_count,dev_last_seen,has_dev_occurrence";
export const EVENT_COLUMNS = "id,occurred_at,severity,app_version,build,platform,env,user_role,message,context,sample_reason,coalesced_count";
export const TRANSITION_COLUMNS = "id,at,from_status,to_status,kind,reason";
export const KNOWN_SOURCES = ["cron", "client", "db", "edge"] as const;

const HOUR = 3_600_000;
const SINCE: Record<string, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

function throwIfError(error: unknown): void {
  if (error) throw error;
}

/** Applies the filters to a select builder (also used by the tests to assert the exact request). */
export function applyFilters(q: any, f: IssueFilters, now: number): any {
  let b = q;
  if (f.status === "active") b = b.in("status", ["open", "acknowledged"]);
  else if (f.status !== "all") b = b.eq("status", f.status);
  if (f.severity !== "all") b = b.eq("severity", f.severity);
  if (f.source === "other") b = b.not("source", "in", `(${["cron", "client", "db", "edge"].join(",")})`);
  else if (f.source !== "all") b = b.eq("source", f.source);
  if (f.recency !== "all") b = b.gte("last_seen", new Date(now - SINCE[f.recency]).toISOString());
  // Not a plain `.eq("env", ...)`: a single issue row can carry both production and development
  // occurrences (prod_occurrence_count / dev_occurrence_count are independent counters, not a fingerprint
  // split), so "production" / "development" are existence checks, not mutually-exclusive partitions --
  // a mixed-environment issue correctly appears under both.
  if (f.environment === "production") b = b.gt("prod_occurrence_count", 0);
  else if (f.environment === "development") b = b.eq("has_dev_occurrence", true);
  return b;
}

export function applySort(q: any, sort: SortKey): any {
  // The final `id` key makes the order total: with offset paging, rows that tie on every other key could otherwise be skipped or
  // repeated between pages.
  const byId = (b: any) => b.order("id", { ascending: false });
  if (sort === "severe") return byId(q.order("severity_rank", { ascending: false }).order("last_seen", { ascending: false }));
  if (sort === "frequent") return byId(q.order("occurrence_count", { ascending: false }).order("last_seen", { ascending: false }));
  return byId(q.order("last_seen", { ascending: false }));
}

export async function fetchIssuePage(db: DbClient, f: IssueFilters, sort: SortKey, page: number, now: number = Date.now()): Promise<{ rows: SystemIssueRow[]; hasMore: boolean }> {
  const from = page * PAGE_SIZE;
  const q = applySort(applyFilters(db.from("system_issues").select(ISSUE_COLUMNS), f, now), sort).range(from, from + PAGE_SIZE); // PAGE_SIZE + 1 rows
  const { data, error } = await q;
  throwIfError(error);
  const all = (Array.isArray(data) ? data : []) as SystemIssueRow[];
  return { rows: all.slice(0, PAGE_SIZE), hasMore: all.length > PAGE_SIZE };
}

async function headCount(db: DbClient, build: (q: unknown) => unknown): Promise<number> {
  const { count, error } = await (build(db.from("system_issues").select("id", { count: "exact", head: true })) as PromiseLike<{ count: number | null; error: unknown }>);
  throwIfError(error);
  return typeof count === "number" ? count : 0;
}

/** Same existence-check scoping as applyFilters's environment branch, applied on top of any other condition. */
function scopeEnv(q: unknown, environment: import("./types").EnvironmentFilter): unknown {
  if (environment === "production") return (q as { gt: (c: string, v: number) => unknown }).gt("prod_occurrence_count", 0);
  if (environment === "development") return (q as { eq: (c: string, v: boolean) => unknown }).eq("has_dev_occurrence", true);
  return q;
}

/**
 * Dashboard numbers: five parallel head-only counts (no rows are transferred). "Recent" = first detected in the
 * last 24 hours. Scoped by the same environment filter as the list, so the cards and the list never disagree --
 * a mixed-environment issue counts toward both the Production and the Development summary.
 */
export async function fetchSummary(db: DbClient, now: number = Date.now(), environment: import("./types").EnvironmentFilter = "all"): Promise<IssueSummary> {
  const [open, acknowledged, muted, reopened, recent] = await Promise.all([
    headCount(db, (q) => scopeEnv((q as { eq: (c: string, v: string) => unknown }).eq("status", "open"), environment)),
    headCount(db, (q) => scopeEnv((q as { eq: (c: string, v: string) => unknown }).eq("status", "acknowledged"), environment)),
    headCount(db, (q) => scopeEnv((q as { eq: (c: string, v: string) => unknown }).eq("status", "muted"), environment)),
    headCount(db, (q) =>
      scopeEnv((q as { in: (c: string, v: string[]) => { gt: (c: string, v: number) => unknown } }).in("status", ["open", "acknowledged"]).gt("reopen_count", 0), environment)
    ),
    headCount(db, (q) => scopeEnv((q as { gte: (c: string, v: string) => unknown }).gte("first_seen", new Date(now - 24 * HOUR).toISOString()), environment)),
  ]);
  return { open, acknowledged, muted, reopened, recent };
}

export type DetailSection = "events" | "transitions" | "buckets";
export interface IssueDetail {
  issue: SystemIssueRow | null;
  events: IssueEventRow[];
  transitions: IssueTransitionRow[];
  buckets: IssueBucketRow[];
  /** Sections whose request failed while the issue itself loaded (the screen shows them with a retry, not a blank page). */
  failed: DetailSection[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A route parameter that cannot be an issue id is "not found" without a request. */
export const isIssueId = (id: unknown): id is string => typeof id === "string" && UUID_RE.test(id);

/**
 * One round of four parallel, bounded requests (no waterfall). A failure of the issue itself throws (the screen shows its error
 * state); a failure of only the events / history / activity section is reported in `failed` and the rest is still shown.
 */
export async function fetchIssueDetail(db: DbClient, id: string): Promise<IssueDetail> {
  const settled = await Promise.allSettled([
    db.from("system_issues").select(ISSUE_COLUMNS).eq("id", id).maybeSingle(),
    db.from("system_issue_events").select(EVENT_COLUMNS).eq("issue_id", id).order("occurred_at", { ascending: false }).limit(20),
    db.from("system_issue_transitions").select(TRANSITION_COLUMNS).eq("issue_id", id).order("at", { ascending: false }).limit(100),
    db.from("system_issue_buckets").select("bucket_start,count").eq("issue_id", id).order("bucket_start", { ascending: false }).limit(24),
  ]);
  if (settled[0].status === "rejected") throw settled[0].reason;
  const [issue, events, transitions, buckets] = settled.map((r) => (r.status === "fulfilled" ? (r.value as { data: unknown; error: unknown }) : { data: null, error: r.reason ?? true }));
  throwIfError(issue.error);
  const failed: DetailSection[] = [];
  if (events.error) failed.push("events");
  if (transitions.error) failed.push("transitions");
  if (buckets.error) failed.push("buckets");
  return {
    issue: (issue.data as SystemIssueRow | null) ?? null,
    events: events.error ? [] : ((events.data ?? []) as IssueEventRow[]),
    transitions: transitions.error ? [] : ((transitions.data ?? []) as IssueTransitionRow[]),
    buckets: buckets.error ? [] : ((buckets.data ?? []) as IssueBucketRow[]),
    failed,
  };
}

function normalize(data: unknown): ActionResult {
  const d = data as { ok?: unknown; status?: unknown; error?: unknown } | null;
  if (d && d.ok === true) return { ok: true, status: typeof d.status === "string" ? d.status : "" };
  const error = d && typeof d.error === "string" && /^[a-z_]{1,40}$/.test(d.error) ? d.error : "unknown";
  return { ok: false, error, status: d && typeof d.status === "string" ? d.status : undefined };
}

async function call(db: DbClient, fn: string, args: Record<string, unknown>): Promise<ActionResult> {
  const { data, error } = await db.rpc(fn, args);
  throwIfError(error);
  return normalize(data);
}

// The lifecycle RPCs already exist (Phase 1) and re-check manager rights and the state transition on the server.
export const acknowledgeIssue = (db: DbClient, id: string) => call(db, "system_issue_acknowledge", { p_issue_id: id });
export const unmuteIssue = (db: DbClient, id: string) => call(db, "system_issue_unmute", { p_issue_id: id });
export const reopenIssue = (db: DbClient, id: string) => call(db, "system_issue_reopen", { p_issue_id: id });
export const muteIssue = (db: DbClient, id: string, until: Date | null) => call(db, "system_issue_mute", { p_issue_id: id, p_until: until ? until.toISOString() : null });
/** `expectedLastSeen`: the server refuses (`stale`) if a newer occurrence arrived after the manager looked. */
export const resolveIssue = (db: DbClient, id: string, reason: "manual_fixed" | "manual_expected", expectedLastSeen: string | null) =>
  call(db, "system_issue_resolve", { p_issue_id: id, p_reason: reason, p_expected_last_seen: expectedLastSeen });
