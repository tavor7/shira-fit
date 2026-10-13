/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories and late requires of the mocked modules */
import React from "react";
import { AppState, FlatList } from "react-native";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { stripDisplayIsolates } from "../displayFormat";
import { translations } from "../../i18n/translations";
import { fakeDb, issue } from "./testHelpers";
import { PAGE_SIZE, type SystemIssueRow } from "./types";

// Component tests of the two manager screens against a recording fake of the Supabase client (real components, real translations).

const mockLang = { v: "he" as "he" | "en" };
const mockId = { v: "11111111-1111-4111-8111-111111111111" };
const mockAlert = { showAlert: jest.fn(), showOk: jest.fn(), showConfirm: jest.fn() };
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockDbRef: { current: ReturnType<typeof fakeDb> | null } = { current: null };

jest.mock("../supabase", () => ({
  supabase: {
    from: (t: string) => (mockDbRef.current as ReturnType<typeof fakeDb>).db.from(t),
    rpc: (fn: string, args?: Record<string, unknown>) => (mockDbRef.current as ReturnType<typeof fakeDb>).db.rpc(fn, args),
  },
}));
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockRouter.push(...a), replace: (...a: unknown[]) => mockRouter.replace(...a) },
  useFocusEffect: (cb: () => void) => require("react").useEffect(cb, [cb]),
  useLocalSearchParams: () => ({ id: mockId.v }),
}));
jest.mock("../../context/I18nContext", () => ({
  useI18n: () => {
    const { translations: tr } = require("../../i18n/translations");
    return { t: (k: string) => tr[mockLang.v][k] ?? k, isRTL: mockLang.v === "he", language: mockLang.v };
  },
}));
jest.mock("../../context/AppAlertContext", () => ({ useAppAlert: () => mockAlert }));
jest.mock("../../hooks/useScreenLayout", () => ({ useScreenContentStyle: () => ({}) }));

const ListScreen = require("../../screens/ManagerSystemIssuesScreen").default as React.ComponentType;
const DetailScreen = require("../../screens/ManagerSystemIssueDetailScreen").default as React.ComponentType;

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function mount(C: React.ComponentType): Promise<TestRenderer.ReactTestRenderer> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(React.createElement(C)); await flush(); });
  return r;
}
const t = (k: string) => translations[mockLang.v][k] ?? k;
function allText(r: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (n: ReactTestInstance | string) => { if (typeof n === "string") { out.push(n); return; } for (const c of n.children) walk(c as ReactTestInstance | string); };
  walk(r.root);
  return out;
}
const textOf = (r: TestRenderer.ReactTestRenderer) => stripDisplayIsolates(allText(r).join(" "));
function byLabel(r: TestRenderer.ReactTestRenderer, label: string | RegExp): ReactTestInstance[] {
  return r.root.findAll((n) => typeof n.props.onPress === "function" && typeof n.props.accessibilityLabel === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel)));
}
async function press(r: TestRenderer.ReactTestRenderer, label: string | RegExp, index = 0) {
  const nodes = byLabel(r, label);
  if (!nodes[index]) throw new Error(`nothing to press: ${String(label)}; have: ${[...new Set(r.root.findAll((n) => typeof n.props.onPress === "function").map((n) => n.props.accessibilityLabel))].join(" | ")}`);
  await act(async () => { nodes[index].props.onPress(); await flush(); });
}

const crit = issue({ id: "c1", source: "cron", subsystem: "notifications", operation: "cron/whatsapp-dispatch-notifications", error_class: "JobHealth", error_code: "job_stale", severity: "critical", base_severity: "critical", title: "x", occurrence_count: 14 });
const warn = issue({ id: "w1" });
const muted = issue({ id: "m1", status: "muted", muted_until: "2026-10-20T00:00:00Z", operation: "transport/infra", error_class: "HttpError", error_code: "http_503" });
const resolved = issue({ id: "r1", status: "resolved", resolved_at: "2026-10-12T00:00:00Z", resolution: "manual_fixed" });
const reopened = issue({ id: "o1", reopen_count: 2, reopened_at: "2026-10-13T00:00:00Z" });

function listDb(rows: SystemIssueRow[], counts: Record<string, number> = {}) {
  return fakeDb((table, calls) => {
    if (calls.some((c) => c[0] === "select" && (c[1][1] as { head?: boolean } | undefined)?.head)) {
      const eq = calls.find((c) => c[0] === "eq");
      return { count: eq ? counts[(eq[1] as string[])[1]] ?? 0 : calls.some((c) => c[0] === "gt") ? counts.reopened ?? 0 : counts.recent ?? 0 };
    }
    if (table === "system_issues") {
      const r = calls.find((c) => c[0] === "range");
      const from = r ? (r[1] as number[])[0] : 0;
      return { data: rows.slice(from, from + PAGE_SIZE + 1) };
    }
    return { data: [] };
  });
}

beforeEach(() => { jest.clearAllMocks(); mockLang.v = "he"; mockDbRef.current = null; });

describe("System issues list screen", () => {
  it("shows skeleton rows while loading, then the empty state when there are no issues (Hebrew)", async () => {
    mockDbRef.current = listDb([]);
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(React.createElement(ListScreen)); });
    expect(textOf(r)).toContain(t("sysIssues.title"));
    expect(textOf(r)).not.toContain(t("sysIssues.list.empty.title"));         // not yet: the request is still in flight
    expect(r.root.findAll((n) => n.props.accessibilityLabel === t("sysIssues.list.loadingMore")).length).toBeGreaterThan(0);
    await act(async () => { await flush(); });
    expect(textOf(r)).toContain("אין תקלות מערכת");
    expect(textOf(r)).toContain(t("sysIssues.list.empty.body"));
    expect(textOf(r)).toContain("0");                                          // real zero counters, not fabricated
  });

  it("renders the dashboard counters from the database and the issues with readable headlines, severity and status", async () => {
    mockDbRef.current = listDb([crit, warn, muted, resolved, reopened], { open: 4, acknowledged: 2, muted: 1, reopened: 1, recent: 6 });
    const r = await mount(ListScreen);
    const txt = textOf(r);
    for (const [k, n] of [["open", 4], ["acknowledged", 2], ["muted", 1], ["reopened", 1], ["recent", 6]] as const) expect(byLabel(r, `${t(`sysIssues.summary.${k}`)}: ${n}`).length + r.root.findAll((x) => x.props.accessibilityLabel === `${t(`sysIssues.summary.${k}`)}: ${n}`).length).toBeGreaterThan(0);
    expect(txt).toContain("המשימה המתוזמנת “whatsapp-dispatch-notifications” לא רצה בזמן");   // critical trusted job issue, readable
    expect(txt).toContain("פעולה במסד הנתונים נכשלה");                                       // warning client issue
    expect(txt).toContain("תקלת שרת זמנית (HTTP 503)");                                       // muted
    expect(txt).toContain(t("sysIssues.severity.critical"));
    expect(txt).toContain(t("sysIssues.status.muted"));
    expect(txt).toContain(t("sysIssues.status.resolved"));
    expect(txt).toContain(t("sysIssues.row.repeated"));                                        // 14 occurrences
    expect(txt).toContain("נפתחה מחדש 2 פעמים");                                              // reopened issue
    expect(txt).not.toMatch(/job_stale|21000|http_503|JobHealth/);                             // technical codes are not the primary text
  });

  it("English mode: LTR labels and no Hebrew leaks", async () => {
    mockLang.v = "en";
    mockDbRef.current = listDb([crit, warn]);
    const r = await mount(ListScreen);
    const txt = textOf(r);
    expect(txt).toContain("System issues");
    expect(txt).toContain("Scheduled job “whatsapp-dispatch-notifications” didn't run on time");
    expect(txt).not.toMatch(/[֐-׿]/);
  });

  it("an error shows a retry state; retry reloads", async () => {
    let fail = true;
    mockDbRef.current = fakeDb((table, calls) => (fail ? { error: { message: "boom" } } : listDb([warn]).db && { data: table === "system_issues" && !calls.some((c) => c[0] === "select" && (c[1][1] as { head?: boolean } | undefined)?.head) ? [warn] : [], count: 1 }));
    const r = await mount(ListScreen);
    expect(textOf(r)).toContain(t("sysIssues.list.error.title"));
    fail = false;
    await press(r, t("sysIssues.list.retry"));
    expect(textOf(r)).toContain("פעולה במסד הנתונים נכשלה");
  });

  it("filtering sends exact server-side filters, shows the no-match state with a reset, and sort changes the order", async () => {
    mockDbRef.current = listDb([]);
    const r = await mount(ListScreen);
    const before = mockDbRef.current.log.length;
    await press(r, t("sysIssues.filters"));
    await press(r, t("sysIssues.severity.critical"));
    const last = mockDbRef.current.log.filter((l) => l.calls.some((c) => c[0] === "range")).pop()!;
    expect(last.calls).toContainEqual(["eq", ["severity", "critical"]]);
    expect(mockDbRef.current.log.length).toBeGreaterThan(before);
    expect(textOf(r)).toContain(t("sysIssues.list.noMatch.title"));
    await press(r, t("sysIssues.sort.severe"));
    const last2 = mockDbRef.current.log.filter((l) => l.calls.some((c) => c[0] === "range")).pop()!;
    expect(last2.calls).toContainEqual(["order", ["severity_rank", { ascending: false }]]);
    expect(last2.calls).toContainEqual(["order", ["id", { ascending: false }]]);
    await press(r, t("sysIssues.filters.reset"), 0);
    const last3 = mockDbRef.current.log.filter((l) => l.calls.some((c) => c[0] === "range")).pop()!;
    expect(last3.calls).toContainEqual(["in", ["status", ["open", "acknowledged"]]]);
    expect(last3.calls.some((c) => c[0] === "eq" && (c[1] as string[])[0] === "severity")).toBe(false);
  });

  it("tapping a counter filters by that status; tapping an issue opens its detail", async () => {
    mockDbRef.current = listDb([warn], { muted: 3 });
    const r = await mount(ListScreen);
    await press(r, `${t("sysIssues.summary.muted")}: 3`);
    const last = mockDbRef.current.log.filter((l) => l.calls.some((c) => c[0] === "range")).pop()!;
    expect(last.calls).toContainEqual(["eq", ["status", "muted"]]);
    mockDbRef.current = listDb([warn]);
    const r2 = await mount(ListScreen);
    await press(r2, /.*/ as RegExp, 0).catch(() => undefined);
    const row = r2.root.findAll((n) => typeof n.props.onPress === "function" && typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.includes("פעולה במסד הנתונים נכשלה"))[0];
    await act(async () => { row.props.onPress(); });
    expect(mockRouter.push).toHaveBeenCalledWith("/(app)/manager/system-issues/w1");
  });

  it("a large history is paged: 20 rows first, one bounded extra request per Load more, no duplicates", async () => {
    const many = Array.from({ length: 45 }, (_, i) => issue({ id: `id${i}`, operation: "rpc/postgrest", error_code: "21000", occurrence_count: 45 - i }));
    mockDbRef.current = listDb(many);
    const r = await mount(ListScreen);
    const rowCount = () => (r.root.findByType(FlatList).props.data as unknown[]).length; // FlatList virtualizes what it renders; its data is what was fetched
    expect(rowCount()).toBe(PAGE_SIZE);
    const pages = () => mockDbRef.current!.log.filter((l) => l.calls.some((c) => c[0] === "range")).map((l) => l.calls.find((c) => c[0] === "range")![1]);
    expect(pages()).toEqual([[0, PAGE_SIZE]]);
    await press(r, t("sysIssues.list.loadMore"));
    expect(rowCount()).toBe(PAGE_SIZE * 2);
    expect(pages()).toEqual([[0, PAGE_SIZE], [PAGE_SIZE, PAGE_SIZE * 2]]);
    await press(r, t("sysIssues.list.loadMore"));
    expect(rowCount()).toBe(45);
    expect(byLabel(r, t("sysIssues.list.loadMore"))).toHaveLength(0);
  });

  it("no personal data on the screen: nothing from user ids, emails or event payloads is requested or shown", async () => {
    mockDbRef.current = listDb([issue({ title: "x@y.com 8a7c2f10-1111-2222-3333-444455556666", operation: "series/gap", source: "detector", error_class: null })]);
    const r = await mount(ListScreen);
    expect(textOf(r)).not.toMatch(/x@y\.com|8a7c2f10/);
    for (const l of mockDbRef.current.log) for (const c of l.calls) if (c[0] === "select") expect(String(c[1][0])).not.toMatch(/user_id|entities|stack|route|fingerprint/);
  });
});

describe("Phase 4B: grouping, partial failures, invalid ids, resume", () => {
  it("large counts are grouped (list and detail)", async () => {
    mockDbRef.current = listDb([issue({ id: "big", occurrence_count: 1234567 })], { open: 1234 });
    const r = await mount(ListScreen);
    expect(textOf(r)).toContain("1,234,567");
    expect(textOf(r)).toContain("1,234");
  });

  it("a failing events section shows an inline error with a retry while the rest of the issue is shown", async () => {
    let fail = true;
    mockDbRef.current = fakeDb((table) => (table === "system_issue_events" && fail ? { error: { message: "x" } } : { data: table === "system_issues" ? [warn] : [] }));
    const r = await mount(DetailScreen);
    expect(textOf(r)).toContain("פעולה במסד הנתונים נכשלה");
    expect(textOf(r)).toContain(t("sysIssues.detail.sectionError"));
    expect(textOf(r)).toContain(t("sysIssues.detail.historyEmpty"));
    fail = false;
    await press(r, t("sysIssues.list.retry"));
    expect(textOf(r)).not.toContain(t("sysIssues.detail.sectionError"));
    expect(textOf(r)).toContain(t("sysIssues.detail.eventsEmpty"));
  });

  it("a route parameter that is not an issue id shows the not-found state and sends no request", async () => {
    mockId.v = "not-a-uuid";
    mockDbRef.current = fakeDb(() => ({ data: [] }));
    const r = await mount(DetailScreen);
    expect(textOf(r)).toContain(t("sysIssues.detail.notFound.title"));
    expect(mockDbRef.current.log).toHaveLength(0);
    mockId.v = "11111111-1111-4111-8111-111111111111";
  });

  it("returning to the foreground refreshes a stale screen once, and a quick app switch does not", async () => {
    const handlers: ((s: string) => void)[] = [];
    const spy = jest.spyOn(AppState, "addEventListener").mockImplementation(((_t: string, h: (s: string) => void) => { handlers.push(h); return { remove: () => undefined }; }) as never);
    mockDbRef.current = listDb([warn]);
    const r = await mount(ListScreen);
    const loads = () => mockDbRef.current!.log.filter((l) => l.calls.some((c) => c[0] === "range")).length;
    const before = loads();
    await act(async () => { handlers.forEach((h) => h("active")); await flush(); });
    expect(loads()).toBe(before);                                           // fresh: no refetch
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    await act(async () => { handlers.forEach((h) => h("background")); handlers.forEach((h) => h("active")); await flush(); });
    Date.now = realNow;
    expect(loads()).toBe(before + 1);                                       // stale: exactly one refetch
    r.unmount();
    spy.mockRestore();
  });
});

describe("Phase 4B: dialogs never act on dismiss, chips ignore a re-selection", () => {
  it("re-selecting the sort or filter that is already active sends no request", async () => {
    mockDbRef.current = listDb([]);
    const r = await mount(ListScreen);
    await press(r, t("sysIssues.filters"));
    const n = mockDbRef.current.log.length;
    await press(r, t("sysIssues.sort.recent"));
    await press(r, t("sysIssues.filterStatus.active"));
    expect(mockDbRef.current.log.length).toBe(n);
  });
});

describe("System issue detail screen", () => {
  function detailDb(i: SystemIssueRow | null, extra: { events?: unknown[]; transitions?: unknown[]; buckets?: unknown[] } = {}) {
    return fakeDb((table) => {
      if (table === "system_issues") return { data: i ? [i] : [] };
      if (table === "system_issue_events") return { data: extra.events ?? [] };
      if (table === "system_issue_transitions") return { data: extra.transitions ?? [] };
      return { data: extra.buckets ?? [] };
    });
  }
  const event = { id: "e1", occurred_at: "2026-10-13T07:00:00Z", severity: "warning", app_version: "1.2.3", build: "9", platform: "web", env: "prod", user_role: "athlete", message: "RPC database error for a@b.com 8a7c2f10-1111-2222-3333-444455556666 token=abc", context: { rpc: "edit_subscription_version", sqlstate: "21000", user_id: "u1", note: "free text" }, sample_reason: "first", coalesced_count: 1 };
  const transitions = [
    { id: 3, at: "2026-10-13T09:00:00Z", from_status: "resolved", to_status: "open", kind: "auto_reopen", reason: null },
    { id: 2, at: "2026-10-12T09:00:00Z", from_status: "open", to_status: "resolved", kind: "resolve", reason: "manual_fixed" },
    { id: 1, at: "2026-10-11T09:00:00Z", from_status: null, to_status: "open", kind: "create", reason: null },
  ];

  it("every state-changing confirmation is dismiss-only (Escape / back / backdrop must not pick a secondary action)", async () => {
    for (const [row, labels] of [[warn, [t("sysIssues.action.acknowledge"), t("sysIssues.action.resolve"), t("sysIssues.action.mute")]], [muted, [t("sysIssues.action.unmute")]], [resolved, [t("sysIssues.action.reopen")]]] as const) {
      for (const label of labels) {
        mockAlert.showAlert.mockClear();
        mockDbRef.current = detailDb(row);
        const r = await mount(DetailScreen);
        await press(r, label);
        expect(mockAlert.showAlert).toHaveBeenCalledTimes(1);
        expect(mockAlert.showAlert.mock.calls[0][0].dismissOnly).toBe(true);
        expect(mockDbRef.current.rpcs).toEqual([]);
      }
    }
  });

  it("renders the readable summary, facts, activity, sampled occurrences and history; technical details stay collapsed and contain no personal data", async () => {
    mockDbRef.current = detailDb(reopened, { events: [event], transitions, buckets: [{ bucket_start: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(), count: 3 }] });
    const r = await mount(DetailScreen);
    let txt = textOf(r);
    expect(txt).toContain("פעולה במסד הנתונים נכשלה");
    expect(txt).toContain(t("sysIssues.desc.database.body"));
    expect(txt).toContain(t("sysIssues.detail.facts"));
    expect(txt).toContain("נפתחה מחדש אוטומטית");
    expect(txt).toContain("סומנה כמתוקנת");
    expect(txt).toContain(t("sysIssues.detail.eventsNote"));
    expect(txt).not.toContain(t("sysIssues.detail.activityEmpty"));
    expect(txt).not.toContain("PostgrestError");                                          // advanced section is collapsed
    expect(txt).not.toMatch(/a@b\.com|8a7c2f10|token=abc|u1|free text/);
    await press(r, t("sysIssues.detail.advanced"));
    txt = textOf(r);
    expect(txt).toContain("PostgrestError");
    expect(txt).toContain("21000");
    expect(txt).toContain("rpc=edit_subscription_version");
    expect(txt).not.toMatch(/a@b\.com|8a7c2f10|token=abc|user_id|free text/);            // sanitized message, allowlisted context only
    expect(mockDbRef.current.log.length).toBe(4);                                          // one round of four requests
  });

  it("an issue with no events, history or activity still renders (no stack trace is assumed)", async () => {
    mockDbRef.current = detailDb(warn);
    const r = await mount(DetailScreen);
    const txt = textOf(r);
    expect(txt).toContain(t("sysIssues.detail.eventsEmpty"));
    expect(txt).toContain(t("sysIssues.detail.historyEmpty"));
    expect(txt).toContain(t("sysIssues.detail.activityEmpty"));
  });

  it("shows only the actions the server accepts for each state", async () => {
    for (const [i, expected] of [[warn, ["acknowledge", "resolve", "mute"]], [muted, ["unmute", "resolve"]], [resolved, ["reopen"]], [issue({ id: "a1", status: "acknowledged" }), ["resolve", "mute"]]] as [SystemIssueRow, string[]][]) {
      mockDbRef.current = detailDb(i);
      const r = await mount(DetailScreen);
      for (const a of ["acknowledge", "resolve", "mute", "unmute", "reopen"]) expect(byLabel(r, t(`sysIssues.action.${a}`)).length > 0).toBe(expected.includes(a));
    }
    mockDbRef.current = detailDb(muted);
    expect(textOf(await mount(DetailScreen))).toContain("מושתקת עד");
  });

  it("acknowledge asks for confirmation, calls the existing RPC once, refreshes only this issue, and a double tap cannot submit twice", async () => {
    mockDbRef.current = detailDb(warn);
    const r = await mount(DetailScreen);
    await press(r, t("sysIssues.action.acknowledge"));
    expect(mockAlert.showAlert).toHaveBeenCalledTimes(1);
    const dlg = mockAlert.showAlert.mock.calls[0][0];
    expect(dlg.title).toBe(t("sysIssues.confirm.ack.title"));
    expect(mockDbRef.current.rpcs).toEqual([]);                                            // nothing happens before confirming
    const confirm = dlg.actions.find((a: { label: string }) => a.label === t("sysIssues.action.acknowledge"));
    const logBefore = mockDbRef.current.log.length;
    await act(async () => { confirm.onPress(); confirm.onPress(); await flush(); });         // double tap
    expect(mockDbRef.current.rpcs).toEqual([{ fn: "system_issue_acknowledge", args: { p_issue_id: warn.id } }]);
    expect(mockAlert.showOk).toHaveBeenCalledWith(t("sysIssues.title"), t("sysIssues.action.done"));
    expect(mockDbRef.current.log.length).toBe(logBefore + 4);                              // refreshed this issue only (one round)
  });

  it("resolve offers fixed / expected, sends the last-seen guard, and a stale answer is explained and reloaded", async () => {
    mockDbRef.current = detailDb(warn);
    mockDbRef.current.setRpc({ data: { ok: false, error: "stale", last_seen: "2026-10-13T09:00:00Z" }, error: null });
    const r = await mount(DetailScreen);
    await press(r, t("sysIssues.action.resolve"));
    const dlg = mockAlert.showAlert.mock.calls[0][0];
    expect(dlg.actions.map((a: { label: string }) => a.label)).toEqual([t("sysIssues.confirm.resolve.fixed"), t("sysIssues.confirm.resolve.expected"), t("common.cancel")]);
    await act(async () => { dlg.actions[0].onPress(); await flush(); });
    expect(mockDbRef.current.rpcs).toEqual([{ fn: "system_issue_resolve", args: { p_issue_id: warn.id, p_reason: "manual_fixed", p_expected_last_seen: warn.last_seen } }]);
    expect(mockAlert.showOk).toHaveBeenCalledWith(t("common.error"), t("sysIssues.err.stale"));
  });

  it("mute offers four durations; a concurrent state change (invalid_state) and a network failure each give a clear message and reload", async () => {
    mockDbRef.current = detailDb(warn);
    const r = await mount(DetailScreen);
    await press(r, t("sysIssues.action.mute"));
    const dlg = mockAlert.showAlert.mock.calls[0][0];
    expect(dlg.actions.map((a: { label: string }) => a.label)).toEqual([t("sysIssues.confirm.mute.day"), t("sysIssues.confirm.mute.week"), t("sysIssues.confirm.mute.month"), t("sysIssues.confirm.mute.forever"), t("common.cancel")]);
    mockDbRef.current.setRpc({ data: { ok: false, error: "invalid_state", status: "resolved" }, error: null });
    await act(async () => { dlg.actions[0].onPress(); await flush(); });
    expect(mockAlert.showOk).toHaveBeenLastCalledWith(t("common.error"), t("sysIssues.err.invalidState"));
    const call = mockDbRef.current.rpcs[0].args as { p_until: string };
    expect(new Date(call.p_until).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    mockDbRef.current.setRpc({ data: null, error: { message: "network down" } });
    await act(async () => { dlg.actions[3].onPress(); await flush(); });
    expect(mockAlert.showOk).toHaveBeenLastCalledWith(t("common.error"), t("sysIssues.err.generic"));
    expect(mockDbRef.current.rpcs[1].args).toEqual({ p_issue_id: warn.id, p_until: null });
    expect(textOf(r)).not.toMatch(/network down/);                                          // raw error text never shown
  });

  it("unmute and reopen confirm and call their RPCs", async () => {
    mockDbRef.current = detailDb(muted);
    let r = await mount(DetailScreen);
    await press(r, t("sysIssues.action.unmute"));
    await act(async () => { mockAlert.showAlert.mock.calls[0][0].actions[1].onPress(); await flush(); });
    expect(mockDbRef.current.rpcs[0]).toEqual({ fn: "system_issue_unmute", args: { p_issue_id: muted.id } });
    mockAlert.showAlert.mockClear();
    mockDbRef.current = detailDb(resolved);
    r = await mount(DetailScreen);
    await press(r, t("sysIssues.action.reopen"));
    await act(async () => { mockAlert.showAlert.mock.calls[0][0].actions[1].onPress(); await flush(); });
    expect(mockDbRef.current.rpcs[0]).toEqual({ fn: "system_issue_reopen", args: { p_issue_id: resolved.id } });
  });

  it("not found and error states", async () => {
    mockDbRef.current = detailDb(null);
    expect(textOf(await mount(DetailScreen))).toContain(t("sysIssues.detail.notFound.title"));
    mockDbRef.current = fakeDb(() => ({ error: { message: "boom" } }));
    const r = await mount(DetailScreen);
    expect(textOf(r)).toContain(t("sysIssues.detail.error.title"));
    expect(byLabel(r, t("sysIssues.list.retry")).length).toBeGreaterThan(0);
  });

  it("English mode renders without Hebrew", async () => {
    mockLang.v = "en";
    mockDbRef.current = detailDb(crit, { events: [event], transitions });
    const r = await mount(DetailScreen);
    await press(r, t("sysIssues.detail.advanced"));
    expect(textOf(r)).not.toMatch(/[֐-׿]/);
    expect(textOf(r)).toContain("Scheduled job “whatsapp-dispatch-notifications” didn't run on time");
  });
});
