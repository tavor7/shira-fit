/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { stripDisplayIsolates } from "../displayFormat";
import { translations } from "../../i18n/translations";
import { canRoleAccessAppPath } from "../roleRouteAccess";
import { getManagerParentHref, isManagerOverviewFlatTool } from "../sessionsHomeNavigation";
import { isIssueId, acknowledgeIssue, applyFilters, applySort, EVENT_COLUMNS, fetchIssueDetail, fetchIssuePage, fetchSummary, ISSUE_COLUMNS, muteIssue, reopenIssue, resolveIssue, unmuteIssue } from "./queries";
import {
  actionErrorKey, activityBars, allowedActions, describeIssue, fill, formatCount, isRepeated, issueExplanation, issueHeadline, relativeTime, safeContext, safeText,
  severityTone, sourceKey, statusTone,
} from "./presentation";
import { DEFAULT_FILTERS, PAGE_SIZE, type SystemIssueRow } from "./types";
import { fakeDb, issue } from "./testHelpers";

const SRC = path.resolve(__dirname, "../..");
const tFor = (lang: "en" | "he") => (k: string) => translations[lang][k] ?? k;

const names = (calls: [string, unknown[]][]) => calls.map((c) => c[0]);

describe("presentation: readable categories, never the raw code as the headline", () => {
  const cases: [Partial<SystemIssueRow>, string, string][] = [
    [{ source: "cron", operation: "cron/whatsapp-dispatch-notifications", error_class: "JobHealth", error_code: "job_stale" }, "en", "Scheduled job “whatsapp-dispatch-notifications” didn't run on time"],
    [{ source: "cron", operation: "cron/generate-subscription-charges", error_class: "JobHealth", error_code: "job_failed" }, "en", "Scheduled job “generate-subscription-charges” failed"],
    [{ operation: "rpc/postgrest", error_code: "21000" }, "en", "A database operation failed"],
    [{ operation: "transport/infra", error_class: "HttpError", error_code: "http_503" }, "en", "Temporary server failure (HTTP 503)"],
    [{ operation: "transport/server", error_class: "HttpError", error_code: "http_500" }, "en", "Server error (HTTP 500)"],
    [{ operation: "rpc/edit_subscription_version", error_class: "RpcOutcome", error_code: "no_current_version" }, "en", "Subscription processing failed"],
    [{ operation: "rpc/register_for_session", error_class: "RpcOutcome", error_code: "no_profile" }, "en", "An app request ended with an internal error"],
    [{ source: "cron", operation: "cron/whatsapp-dispatch-notifications", error_class: "JobHealth", error_code: "job_stale" }, "he", "המשימה המתוזמנת “whatsapp-dispatch-notifications” לא רצה בזמן"],
    [{ operation: "rpc/postgrest", error_code: "21000" }, "he", "פעולה במסד הנתונים נכשלה"],
    [{ operation: "transport/infra", error_class: "HttpError", error_code: "http_503" }, "he", "תקלת שרת זמנית (HTTP 503)"],
  ];
  it.each(cases)("%j (%s)", (over, lang, expected) => {
    expect(stripDisplayIsolates(issueHeadline(issue(over), tFor(lang as "en" | "he")))).toBe(expected);
  });

  it("an unknown issue is shown with its sanitized server title and a neutral explanation; the code stays out of the headline", () => {
    const i = issue({ source: "detector", operation: "series/gap", error_class: null, error_code: "X9", title: "Series gap for alice@example.com 8a7c2f10-1111-2222-3333-444455556666" });
    const d = describeIssue(i);
    expect(d.category).toBe("unknown");
    expect(d.usesServerTitle).toBe(true);
    const h = issueHeadline(i, tFor("en"));
    expect(h).toContain("Series gap");
    expect(h).not.toMatch(/alice|example\.com|8a7c2f10/);
    expect(h).not.toContain("X9");
    expect(issueExplanation(i, tFor("en"))).toBe(translations.en["sysIssues.desc.unknown.body"]);
  });

  it("a malformed job name never reaches the headline", () => {
    const i = issue({ source: "cron", operation: "cron/Bad Name!;drop", error_class: "JobHealth", error_code: "job_stale", title: "t" });
    expect(describeIssue(i).category).toBe("unknown");
  });

  it("severity/status/source tones and keys, repeated detection", () => {
    expect(["critical", "error", "warning", "info"].map((s) => severityTone(s as never))).toEqual(["danger", "danger", "warning", "info"]);
    expect(["open", "acknowledged", "muted", "resolved"].map((s) => statusTone(s as never))).toEqual(["danger", "info", "neutral", "success"]);
    expect([sourceKey("cron"), sourceKey("client"), sourceKey("weird")]).toEqual(["sysIssues.source.cron", "sysIssues.source.client", "sysIssues.source.other"]);
    expect(isRepeated(issue({ occurrence_count: 9 }))).toBe(false);
    expect(isRepeated(issue({ occurrence_count: 10 }))).toBe(true);
  });

  it("safeText scrubs secrets, ids and emails and bounds length; safeContext keeps only allowlisted scalar keys", () => {
    const raw = "failed for a@b.com token=abc123 Bearer eyJhbGciOi.eyJzdWIiOi.sig 8a7c2f10-1111-2222-3333-444455556666 " + "x".repeat(500);
    const s = safeText(raw, 120);
    expect(s).not.toMatch(/a@b\.com|abc123|eyJ|8a7c2f10/);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(safeContext({ rpc: "register_for_session", sqlstate: "21000", http_status: 503, retryable: true, user_id: "u", email: "a@b.com", entities: { x: 1 }, phase: { a: 1 }, job: "bad value with spaces" })).toEqual([["rpc", "register_for_session"], ["sqlstate", "21000"], ["http_status", "503"], ["retryable", "true"]]);
    expect(safeContext(null)).toEqual([]);
    expect(safeContext([1])).toEqual([]);
  });

  it("allowed actions mirror the server state machine", () => {
    expect(allowedActions("open")).toEqual(["acknowledge", "resolve", "mute"]);
    expect(allowedActions("acknowledged")).toEqual(["resolve", "mute"]);
    expect(allowedActions("muted")).toEqual(["unmute", "resolve"]);
    expect(allowedActions("resolved")).toEqual(["reopen"]);
    expect(actionErrorKey("stale")).toBe("sysIssues.err.stale");
    expect(actionErrorKey("invalid_state")).toBe("sysIssues.err.invalidState");
    expect(actionErrorKey("whatever")).toBe("sysIssues.err.generic");
  });

  it("relative time, template fill and 24-hour activity bars", () => {
    const now = Date.parse("2026-10-13T12:30:00Z");
    const t = tFor("en");
    expect(relativeTime("2026-10-13T12:29:40Z", now, t)).toBe("just now");
    expect(relativeTime("2026-10-13T12:00:00Z", now, t)).toBe("30 min ago");
    expect(relativeTime("2026-10-13T06:30:00Z", now, t)).toBe("6 h ago");
    expect(relativeTime("2026-10-10T12:30:00Z", now, t)).toBe("3 d ago");
    expect(relativeTime("garbage", now, t)).toBe("");
    expect(fill("{a} and {b}", { a: 1, b: "x" })).toBe("1 and x");
    const bars = activityBars([{ bucket_start: "2026-10-13T12:00:00Z", count: 4 }, { bucket_start: "2026-10-13T10:00:00Z", count: 2 }, { bucket_start: "2026-10-11T10:00:00Z", count: 99 }], now);
    expect(bars).toHaveLength(24);
    expect(bars[23]).toBe(4);
    expect(bars[21]).toBe(2);
    expect(bars.reduce((a, b) => a + b, 0)).toBe(6);
  });
});

describe("Phase 4B regressions", () => {
  it("server titles are scrubbed but long identifiers stay readable (the client reporter's token mask must not eat job names)", () => {
    expect(safeText("notifications: cron/whatsapp-dispatch-notifications-and-more-extra-long-name (job_stale)")).toContain("cron/whatsapp-dispatch-notifications-and-more-extra-long-name");
    expect(safeText("x@y.com 8a7c2f10-1111-2222-3333-444455556666 Bearer abc.def password=hunter2")).not.toMatch(/y\.com|8a7c2f10|abc\.def|hunter2/);
    expect(safeText({ a: 1 })).toBe("");
    expect(safeText("a".repeat(500), 50)).toHaveLength(50);
  });
  it("counts are grouped in the UI language", () => {
    expect(formatCount(1234567, "en")).toBe("1,234,567");
    expect(formatCount(1234567, "he")).toBe("1,234,567");
    expect(formatCount(0, "en")).toBe("0");
  });
  it("the HTTP status is one left-to-right unit so Hebrew shows (HTTP 503), not (503 HTTP)", () => {
    const h = issueHeadline(issue({ operation: "transport/infra", error_class: "HttpError", error_code: "http_503" }), tFor("he"));
    expect(h).toContain("\u2066HTTP 503\u2069");
    expect(stripDisplayIsolates(h)).toBe("תקלת שרת זמנית (HTTP 503)");
  });
  it("only a UUID is an issue id", () => {
    expect(isIssueId("11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const bad of ["", "abc", "1", "11111111-1111-4111-8111-11111111111", "../x", undefined, null, 5, ["a"]]) expect(isIssueId(bad as never)).toBe(false);
  });
  it("detail: a failing section is reported and the rest still loads; a failing issue request throws", async () => {
    const part = await fetchIssueDetail(fakeDb((table) => (table === "system_issue_events" ? { error: { message: "x" } } : { data: table === "system_issues" ? [issue()] : [] })).db, "x");
    expect(part.issue).not.toBeNull();
    expect(part.failed).toEqual(["events"]);
    expect(part.events).toEqual([]);
    const all = await fetchIssueDetail(fakeDb((table) => (table === "system_issues" ? { data: [issue()] } : { error: { message: "x" } })).db, "x");
    expect(all.failed.sort()).toEqual(["buckets", "events", "transitions"]);
    await expect(fetchIssueDetail(fakeDb((table) => (table === "system_issues" ? { error: { message: "x" } } : { data: [] })).db, "x")).rejects.toBeTruthy();
  });
});

describe("queries: bounded, server-side, only the granted columns", () => {
  it("the issue list is a server-paged request of PAGE_SIZE+1 rows with the exact filters and sort", async () => {
    const { db, log } = fakeDb(() => ({ data: Array.from({ length: PAGE_SIZE + 1 }, (_, i) => issue({ id: `${i}` })) }));
    const res = await fetchIssuePage(db, { status: "active", severity: "error", source: "cron", recency: "7d" }, "severe", 2, Date.parse("2026-10-13T00:00:00Z"));
    expect(res.rows).toHaveLength(PAGE_SIZE);
    expect(res.hasMore).toBe(true);
    const c = log[0].calls;
    expect(c).toContainEqual(["select", [ISSUE_COLUMNS]]);
    expect(c).toContainEqual(["in", ["status", ["open", "acknowledged"]]]);
    expect(c).toContainEqual(["eq", ["severity", "error"]]);
    expect(c).toContainEqual(["eq", ["source", "cron"]]);
    expect(c).toContainEqual(["gte", ["last_seen", "2026-10-06T00:00:00.000Z"]]);
    expect(c).toContainEqual(["order", ["severity_rank", { ascending: false }]]);
    expect(c).toContainEqual(["order", ["last_seen", { ascending: false }]]);
    expect(c[c.length - 2]).toEqual(["order", ["id", { ascending: false }]]); // total order: last key is the id
    expect(c).toContainEqual(["range", [PAGE_SIZE * 2, PAGE_SIZE * 2 + PAGE_SIZE]]);
    expect(names(c)).not.toContain("limit");
    const short = await fetchIssuePage(fakeDb(() => ({ data: [issue()] })).db, DEFAULT_FILTERS, "recent", 0);
    expect(short).toMatchObject({ hasMore: false });
    expect(short.rows).toHaveLength(1);
  });

  it("every status/severity/source/recency/sort combination builds a valid, finite request", () => {
    const seen = new Set<string>();
    for (const status of ["active", "all", "open", "acknowledged", "muted", "resolved"] as const)
      for (const severity of ["all", "critical", "error", "warning", "info"] as const)
        for (const source of ["all", "cron", "client", "db", "edge", "other"] as const)
          for (const recency of ["all", "24h", "7d", "30d"] as const)
            for (const sort of ["recent", "severe", "frequent"] as const) {
              const calls: [string, unknown[]][] = [];
              const rec: Record<string, unknown> = {};
              for (const m of ["in", "eq", "not", "gte", "order"]) rec[m] = (...a: unknown[]) => { calls.push([m, a]); return rec; };
              applySort(applyFilters(rec, { status, severity, source, recency }, 0), sort);
              seen.add(JSON.stringify(calls));
              expect(calls.length).toBeLessThan(10);
            }
    expect(seen.size).toBeGreaterThan(100);
  });

  it("the three sort orders", () => {
    const sorted = (s: "recent" | "severe" | "frequent") => { const c: unknown[] = []; const r: Record<string, unknown> = {}; r.order = (...a: unknown[]) => { c.push(a); return r; }; applySort(r, s); return c; };
    expect(sorted("recent")).toEqual([["last_seen", { ascending: false }], ["id", { ascending: false }]]);
    expect(sorted("severe")).toEqual([["severity_rank", { ascending: false }], ["last_seen", { ascending: false }], ["id", { ascending: false }]]);
    expect(sorted("frequent")).toEqual([["occurrence_count", { ascending: false }], ["last_seen", { ascending: false }], ["id", { ascending: false }]]);
  });

  it("the dashboard uses five head-only counts and transfers no rows", async () => {
    const { db, log } = fakeDb((_t, calls) => {
      const eq = calls.find((c) => c[0] === "eq");
      const n = eq ? ({ open: 7, acknowledged: 2, muted: 1 } as Record<string, number>)[(eq[1] as string[])[1]] : calls.some((c) => c[0] === "gt") ? 3 : 5;
      return { count: n };
    });
    const s = await fetchSummary(db, Date.parse("2026-10-13T00:00:00Z"));
    expect(s).toEqual({ open: 7, acknowledged: 2, muted: 1, reopened: 3, recent: 5 });
    expect(log).toHaveLength(5);
    for (const l of log) expect(l.calls[0]).toEqual(["select", ["id", { count: "exact", head: true }]]);
    expect(log[4].calls).toContainEqual(["gte", ["first_seen", "2026-10-12T00:00:00.000Z"]]);
  });

  it("issue details: four bounded requests in one round, none of the sensitive columns", async () => {
    const { db, log } = fakeDb((table) => ({ data: table === "system_issues" ? [issue()] : [] }));
    const d = await fetchIssueDetail(db, "11111111-1111-4111-8111-111111111111");
    expect(d.issue?.id).toBeDefined();
    expect(log.map((l) => l.table).sort()).toEqual(["system_issue_buckets", "system_issue_events", "system_issue_transitions", "system_issues"]);
    const lim = (t: string) => log.find((l) => l.table === t)!.calls.find((c) => c[0] === "limit")?.[1][0];
    expect([lim("system_issue_events"), lim("system_issue_transitions"), lim("system_issue_buckets")]).toEqual([20, 100, 24]);
    for (const col of ["user_id", "entities", "stack", "route", "actor_user_id", "acknowledged_by", "resolved_by", "fingerprint", "rule_id"]) {
      expect(EVENT_COLUMNS.split(",")).not.toContain(col);
      expect(ISSUE_COLUMNS.split(",")).not.toContain(col);
    }
    const none = await fetchIssueDetail(fakeDb(() => ({ data: [] })).db, "x");
    expect(none.issue).toBeNull();
  });

  it("errors propagate to the caller (the screen shows an error state)", async () => {
    await expect(fetchIssuePage(fakeDb(() => ({ error: { message: "boom" } })).db, DEFAULT_FILTERS, "recent", 0)).rejects.toBeTruthy();
    await expect(fetchSummary(fakeDb(() => ({ error: { message: "boom" } })).db)).rejects.toBeTruthy();
    await expect(fetchIssueDetail(fakeDb(() => ({ error: { message: "boom" } })).db, "x")).rejects.toBeTruthy();
  });

  it("lifecycle actions call exactly the existing RPCs with exactly their arguments, and normalize the server answer", async () => {
    const f = fakeDb(() => ({}));
    await acknowledgeIssue(f.db, "a"); await unmuteIssue(f.db, "b"); await reopenIssue(f.db, "c");
    await muteIssue(f.db, "d", new Date("2026-10-20T00:00:00Z")); await muteIssue(f.db, "e", null);
    await resolveIssue(f.db, "f", "manual_expected", "2026-10-13T08:00:00Z");
    expect(f.rpcs).toEqual([
      { fn: "system_issue_acknowledge", args: { p_issue_id: "a" } },
      { fn: "system_issue_unmute", args: { p_issue_id: "b" } },
      { fn: "system_issue_reopen", args: { p_issue_id: "c" } },
      { fn: "system_issue_mute", args: { p_issue_id: "d", p_until: "2026-10-20T00:00:00.000Z" } },
      { fn: "system_issue_mute", args: { p_issue_id: "e", p_until: null } },
      { fn: "system_issue_resolve", args: { p_issue_id: "f", p_reason: "manual_expected", p_expected_last_seen: "2026-10-13T08:00:00Z" } },
    ]);
    f.setRpc({ data: { ok: false, error: "stale", last_seen: "x" }, error: null });
    expect(await resolveIssue(f.db, "f", "manual_fixed", "x")).toEqual({ ok: false, error: "stale", status: undefined });
    f.setRpc({ data: { ok: false, error: "Some raw text!" }, error: null });
    expect(await acknowledgeIssue(f.db, "a")).toMatchObject({ ok: false, error: "unknown" });
    f.setRpc({ data: null, error: { message: "network" } });
    await expect(acknowledgeIssue(f.db, "a")).rejects.toBeTruthy();
  });
});

describe("navigation and access", () => {
  const P = "/manager/system-issues";
  it("only managers may open the screens (athletes and coaches are redirected by the shared route guard)", () => {
    for (const p of [P, `${P}/11111111-1111-4111-8111-111111111111`, `/(app)${P}`]) {
      expect(canRoleAccessAppPath("manager", p)).toBe(true);
      expect(canRoleAccessAppPath("athlete", p)).toBe(false);
      expect(canRoleAccessAppPath("coach", p)).toBe(false);
      expect(canRoleAccessAppPath("manager", p, { managerAthletePreview: true })).toBe(true);
      expect(canRoleAccessAppPath(null, p)).toBe(false);
      expect(canRoleAccessAppPath(undefined, p)).toBe(false);
    }
  });

  it("back navigation: the list is a Setup item (Setup on phones, Overview on wide screens), the detail returns to the list", () => {
    expect(isManagerOverviewFlatTool(P)).toBe(false);
    expect(String(getManagerParentHref(P, { setupIndexAvailable: true }))).toBe("/(app)/manager/setup");
    expect(String(getManagerParentHref(P, { setupIndexAvailable: false }))).toBe("/(app)/manager/dashboard");
    expect(String(getManagerParentHref(`${P}/abc`, { setupIndexAvailable: false }))).toBe("/(app)/manager/system-issues");
  });

  it("the entry exists only in manager-only places (Tools list, Setup menu); no athlete, coach or shared screen links to it", () => {
    const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
    expect(read("screens/ManagerToolsScreen.tsx")).toMatch(/menu\.systemIssues[\s\S]*?\/\(app\)\/manager\/system-issues/);
    const walk = (dir: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p); } return out; };
    const offenders = walk(SRC).filter((f) => /system-issues/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f)).filter((f) => !/^(screens\/Manager|lib\/sessionsHomeNavigation|lib\/systemIssues|components\/GlobalQuickMenu|components\/ManagerOverviewTabs|components\/systemIssues)/.test(f));
    expect(offenders).toEqual([]);
    for (const f of walk(path.join(SRC, "..", "app")).filter((x) => /\/(athlete|coach)\//.test(x))) expect(fs.readFileSync(f, "utf8")).not.toMatch(/system-issues|systemIssues/);
  });

  it("the manager screens expose no configuration, rule, scope or ingestion controls", () => {
    for (const f of ["screens/ManagerSystemIssuesScreen.tsx", "screens/ManagerSystemIssueDetailScreen.tsx", "lib/systemIssues/queries.ts"]) {
      const code = fs.readFileSync(path.join(SRC, f), "utf8");
      expect(code).not.toMatch(/system_monitoring_config|system_issue_rules|system_report_quota|client_ingest|client_ingest_scope|service_role|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    }
  });
});

describe("internationalization", () => {
  const keys = (lang: "en" | "he") => Object.keys(translations[lang]).filter((k) => k.startsWith("sysIssues.") || ["menu.systemIssues", "managerTools.systemIssuesSub", "setup.desc.systemIssues", "screen.systemIssues", "screen.systemIssueDetail"].includes(k));
  it("English and Hebrew define exactly the same keys, all non-empty, with the same placeholders", () => {
    expect(keys("he").sort()).toEqual(keys("en").sort());
    expect(keys("en").length).toBeGreaterThan(150);
    for (const k of keys("en")) {
      const en = translations.en[k], he = translations.he[k];
      expect(en.trim().length).toBeGreaterThan(0);
      expect(he.trim().length).toBeGreaterThan(0);
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(he)).toEqual(ph(en));
    }
  });

  it("no Hebrew string is left in English: every Hebrew text contains Hebrew letters, except placeholders-only and the dash", () => {
    for (const k of keys("he")) {
      const he = translations.he[k];
      const rest = he.replace(/\{\w+\}/g, "").replace(/[\s:.,·—\d()]/g, "");
      if (rest.length === 0) continue; // placeholder-only templates and the dash
      expect(/[֐-׿]/.test(he)).toBe(true);
    }
  });

  it("every translation key used by the screens, components and presentation layer exists in both languages", () => {
    const files = ["screens/ManagerSystemIssuesScreen.tsx", "screens/ManagerSystemIssueDetailScreen.tsx", "components/systemIssues/IssueRow.tsx", "components/systemIssues/SummaryCards.tsx", "lib/systemIssues/presentation.ts"];
    const used = new Set<string>();
    for (const f of files) for (const m of fs.readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`](sysIssues\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    // keys built from a fixed set at runtime
    for (const v of ["active", "all", "open", "acknowledged", "muted", "resolved"]) used.add(`sysIssues.filterStatus.${v}`);
    for (const v of ["open", "acknowledged", "muted", "resolved"]) used.add(`sysIssues.status.${v}`);
    for (const v of ["all", "critical", "error", "warning", "info"]) used.add(`sysIssues.severity.${v}`);
    for (const v of ["all", "cron", "client", "db", "edge", "other"]) used.add(`sysIssues.source.${v}`);
    for (const v of ["all", "24h", "7d", "30d"]) used.add(`sysIssues.recency.${v}`);
    for (const v of ["recent", "severe", "frequent"]) used.add(`sysIssues.sort.${v}`);
    for (const v of ["acknowledge", "resolve", "mute", "unmute", "reopen"]) used.add(`sysIssues.action.${v}`);
    for (const v of ["create", "ack", "resolve", "mute", "unmute", "reopen", "auto_reopen", "auto_resolve", "auto_unmute", "escalate"]) used.add(`sysIssues.kind.${v}`);
    for (const v of ["manual_fixed", "manual_expected", "auto_recovered", "auto_quiet"]) used.add(`sysIssues.reason.${v}`);
    for (const v of ["stale", "failed", "missing", "disabled", "stuck", "generic"]) used.add(`sysIssues.desc.job.${v}`);
    const missing = [...used].filter((k) => !(k in translations.en) || !(k in translations.he)).filter((k) => !/\.$/.test(k) && k !== "sysIssues.row.occurrences");
    expect(missing).toEqual([]);
    expect(translations.en["sysIssues.row.occurrences_one"]).toBeDefined();
    expect(translations.he["sysIssues.row.occurrences_one"]).toBeDefined();
  });

  it("Hebrew explanations of every category mention no English technical words other than the identifier placeholders", () => {
    for (const k of ["sysIssues.desc.subscription", "sysIssues.desc.database", "sysIssues.desc.appRequest", "sysIssues.desc.unknown.body", "sysIssues.desc.job.body"]) expect(translations.he[k]).not.toMatch(/[A-Za-z]{3,}/);
  });
});
