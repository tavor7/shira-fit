/**
 * Human-readable presentation of monitoring issues (Phase 4A). Pure. Technical codes are never the primary text: known categories map to
 * plain descriptions (translation keys), an unknown issue gets a neutral generic description plus its server title, and the technical
 * code stays available separately (advanced details). Nothing here reads a user id, token, stack or raw payload.
 */
import { displayLtr } from "../displayFormat";
import { sanitizeMessage } from "../techReporting/sanitize";
import type { IssueBucketRow, IssueSeverity, IssueStatus, SystemIssueRow } from "./types";

export type IssueCategory = "job" | "subscription" | "database" | "temporaryServer" | "serverError" | "appRequest" | "unknown";

export interface IssueDescription {
  category: IssueCategory;
  /** Translation key of the headline (placeholders in `vars`). */
  titleKey: string;
  /** Translation key of the explanation. */
  descKey: string;
  vars: Record<string, string>;
  /** True when no category matched: the (sanitized) server title is shown as the headline. */
  usesServerTitle: boolean;
}

const JOB_CONDITIONS = new Set(["stale", "failed", "missing", "disabled", "stuck"]);
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

/** Safe single-line text from server-provided text (titles, messages): secrets/ids/emails scrubbed, bounded. */
export function safeText(raw: unknown, max = 160): string {
  const s = sanitizeMessage(raw);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function describeIssue(issue: Pick<SystemIssueRow, "source" | "operation" | "error_class" | "error_code" | "title" | "subsystem">): IssueDescription {
  const op = typeof issue.operation === "string" ? issue.operation : "";
  const code = issue.error_code ?? "";
  if (op.startsWith("cron/")) {
    const job = op.slice(5);
    const safeJob = NAME_RE.test(job) ? job : "";
    const cond = code.startsWith("job_") ? code.slice(4) : "";
    if (issue.error_class === "JobHealth" && JOB_CONDITIONS.has(cond) && safeJob) {
      return { category: /subscription/.test(safeJob) ? "subscription" : "job", titleKey: `sysIssues.desc.job.${cond}`, descKey: "sysIssues.desc.job.body", vars: { job: safeJob }, usesServerTitle: false };
    }
    if (safeJob) return { category: /subscription/.test(safeJob) ? "subscription" : "job", titleKey: "sysIssues.desc.job.generic", descKey: "sysIssues.desc.job.body", vars: { job: safeJob }, usesServerTitle: false };
  }
  if (op === "transport/infra") return { category: "temporaryServer", titleKey: "sysIssues.desc.temporaryServer", descKey: "sysIssues.desc.temporaryServer.body", vars: { status: code.replace(/^http_/, "") }, usesServerTitle: false };
  if (op === "transport/server") return { category: "serverError", titleKey: "sysIssues.desc.serverError", descKey: "sysIssues.desc.serverError.body", vars: { status: code.replace(/^http_/, "") }, usesServerTitle: false };
  if (op === "rpc/postgrest") return { category: "database", titleKey: "sysIssues.desc.database", descKey: "sysIssues.desc.database.body", vars: {}, usesServerTitle: false };
  if (op.startsWith("rpc/")) {
    const rpc = op.slice(4);
    if (/subscription/.test(rpc)) return { category: "subscription", titleKey: "sysIssues.desc.subscription", descKey: "sysIssues.desc.subscription.body", vars: {}, usesServerTitle: false };
    return { category: "appRequest", titleKey: "sysIssues.desc.appRequest", descKey: "sysIssues.desc.appRequest.body", vars: {}, usesServerTitle: false };
  }
  return { category: "unknown", titleKey: "", descKey: "sysIssues.desc.unknown.body", vars: {}, usesServerTitle: true };
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Template variables for display: identifiers (job names, statuses) are isolated left-to-right so they stay intact inside Hebrew sentences. */
function displayVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = displayLtr(v);
  return out;
}

/** Headline text for an issue (translated category title, or the sanitized server title for an unknown issue). */
export function issueHeadline(issue: SystemIssueRow, t: (k: string) => string): string {
  const d = describeIssue(issue);
  return d.usesServerTitle ? safeText(issue.title) || t("sysIssues.desc.unknown.title") : fill(t(d.titleKey), displayVars(d.vars));
}

export function issueExplanation(issue: SystemIssueRow, t: (k: string) => string): string {
  const d = describeIssue(issue);
  return fill(t(d.descKey), displayVars(d.vars));
}

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "info";
export function severityTone(s: IssueSeverity): ChipTone {
  return s === "critical" || s === "error" ? "danger" : s === "warning" ? "warning" : "info";
}
export function statusTone(s: IssueStatus): ChipTone {
  return s === "open" ? "danger" : s === "acknowledged" ? "info" : s === "resolved" ? "success" : "neutral";
}
export const severityKey = (s: string) => `sysIssues.severity.${s}`;
export const statusKey = (s: string) => `sysIssues.status.${s}`;
export function sourceKey(source: string): string {
  return ["cron", "client", "db", "edge"].includes(source) ? `sysIssues.source.${source}` : "sysIssues.source.other";
}

/** Repeated = the same technical failure keeps coming back (10+ occurrences). */
export const isRepeated = (issue: Pick<SystemIssueRow, "occurrence_count">): boolean => issue.occurrence_count >= 10;

export type IssueAction = "acknowledge" | "resolve" | "mute" | "unmute" | "reopen";
/** Which lifecycle actions the server accepts from each status (mirrors the SECURITY DEFINER functions of Phase 1). */
export function allowedActions(status: IssueStatus): IssueAction[] {
  switch (status) {
    case "open": return ["acknowledge", "resolve", "mute"];
    case "acknowledged": return ["resolve", "mute"];
    case "muted": return ["unmute", "resolve"];
    case "resolved": return ["reopen"];
    default: return [];
  }
}

export function actionErrorKey(error: string): string {
  switch (error) {
    case "stale": return "sysIssues.err.stale";
    case "invalid_state": return "sysIssues.err.invalidState";
    case "not_found": return "sysIssues.err.notFound";
    case "forbidden": return "sysIssues.err.forbidden";
    default: return "sysIssues.err.generic";
  }
}

export function relativeTime(iso: string, now: number, t: (k: string) => string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("sysIssues.time.justNow");
  if (min < 60) return fill(t("sysIssues.time.minutesAgo"), { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return fill(t("sysIssues.time.hoursAgo"), { n: h });
  return fill(t("sysIssues.time.daysAgo"), { n: Math.floor(h / 24) });
}

/** 24 hourly counts (index 0 = oldest hour, 23 = the current hour) from the bucket rows. */
export function activityBars(buckets: IssueBucketRow[], now: number): number[] {
  const hour = 3_600_000;
  const currentHour = Math.floor(now / hour) * hour;
  const out = new Array<number>(24).fill(0);
  for (const b of buckets) {
    const start = new Date(b.bucket_start).getTime();
    if (!Number.isFinite(start)) continue;
    const idx = 23 - Math.round((currentHour - Math.floor(start / hour) * hour) / hour);
    if (idx >= 0 && idx < 24) out[idx] += Math.max(0, Number(b.count) || 0);
  }
  return out;
}

const CONTEXT_KEYS = ["rpc", "phase", "sqlstate", "http_status", "retryable", "table", "edge_function", "job", "reason", "count", "network_state", "attempt", "duration_ms", "provider", "provider_code", "outcome", "fn", "constraint"];
const SAFE_VALUE = /^[A-Za-z0-9_./:-]{1,80}$/;
/** Allowlisted, scalar, pattern-checked context entries only (never ids, free text or nested values). */
export function safeContext(ctx: unknown): [string, string][] {
  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) return [];
  const out: [string, string][] = [];
  for (const k of CONTEXT_KEYS) {
    const v = (ctx as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out.push([k, String(v)]);
    else if (typeof v === "boolean") out.push([k, v ? "true" : "false"]);
    else if (typeof v === "string" && SAFE_VALUE.test(v)) out.push([k, v]);
  }
  return out;
}

export const transitionKindKey = (kind: string) => `sysIssues.kind.${kind}`;
export const transitionReasonKey = (reason: string) => `sysIssues.reason.${reason}`;
const KNOWN_KINDS = new Set(["create", "ack", "resolve", "mute", "unmute", "reopen", "auto_reopen", "auto_resolve", "auto_unmute", "escalate"]);
const KNOWN_REASONS = new Set(["manual_fixed", "manual_expected", "auto_recovered", "auto_quiet"]);
export const knownKind = (k: string): boolean => KNOWN_KINDS.has(k);
export const knownReason = (r: string | null): r is string => !!r && KNOWN_REASONS.has(r);
