import { isPerfEnabled, setPerfEnabledForTests } from "./perfFlag";
import { sequentialDepth, summarizeStartup, summarizeVisit, type PerfRequestRecord, type PerfVisitRecord } from "./perfAnalysis";
import { perfBeginVisit, perfClear, perfNotePointerDown, perfSetReady, perfSnapshot } from "./perfStore";
import { withPerfTracking } from "./requestTracker";

const URL0 = "https://proj.supabase.co";

afterEach(() => {
  setPerfEnabledForTests(null);
  perfClear();
});

describe("flag", () => {
  it("is off by default (native never enables it)", () => {
    setPerfEnabledForTests(null);
    expect(isPerfEnabled()).toBe(false);
  });
});

describe("withPerfTracking", () => {
  it("disabled: passes the same arguments through, returns the same Response, records nothing", async () => {
    setPerfEnabledForTests(false);
    const res = new Response("{}", { status: 200 });
    const inner = jest.fn(async () => res);
    const init = { method: "POST", body: "x" };
    const out = await withPerfTracking(inner, { supabaseUrl: URL0 })(`${URL0}/rest/v1/rpc/f`, init);
    expect(out).toBe(res);
    expect(inner).toHaveBeenCalledWith(`${URL0}/rest/v1/rpc/f`, init);
    expect(perfSnapshot().requests).toHaveLength(0);
  });

  it("enabled: records only a safe endpoint label, method, status and timings", async () => {
    setPerfEnabledForTests(true);
    const res = new Response("{}", { status: 206 });
    const wrapped = withPerfTracking(async () => res, { supabaseUrl: URL0 });
    const out = await wrapped(`${URL0}/rest/v1/profiles?select=*&user_id=eq.5f1c0b9e-1111-2222-3333-444455556666&phone=0501234567`);
    expect(out).toBe(res);
    await wrapped(`${URL0}/rest/v1/rpc/get_required_consents`, { method: "post" });
    await wrapped(`${URL0}/auth/v1/user`);
    const reqs = perfSnapshot().requests;
    expect(reqs.map((r) => [r.endpoint, r.method, r.status])).toEqual([
      ["rest:profiles", "GET", 206],
      ["rpc:get_required_consents", "POST", 206],
      ["auth:user", "GET", 206],
    ]);
    const serialized = JSON.stringify(perfSnapshot());
    expect(serialized).not.toMatch(/5f1c0b9e|0501234567|select=|proj\.supabase\.co/);
    expect(reqs.every((r) => r.end != null && r.end >= r.start)).toBe(true);
  });

  it("enabled: rethrows the very same error and records status 0", async () => {
    setPerfEnabledForTests(true);
    const err = new TypeError("network down");
    const wrapped = withPerfTracking(async () => {
      throw err;
    }, { supabaseUrl: URL0 });
    await expect(wrapped(`${URL0}/rest/v1/rpc/f`)).rejects.toBe(err);
    expect(perfSnapshot().requests[0]).toMatchObject({ endpoint: "rpc:f", status: 0 });
  });

  it("enabled: ignores requests to other hosts", async () => {
    setPerfEnabledForTests(true);
    await withPerfTracking(async () => new Response(""), { supabaseUrl: URL0 })("https://example.com/x");
    expect(perfSnapshot().requests).toHaveLength(0);
  });

  it("disabled: per-call overhead stays negligible", async () => {
    setPerfEnabledForTests(false);
    const res = new Response("");
    const inner = () => Promise.resolve(res);
    const wrapped = withPerfTracking(inner, { supabaseUrl: URL0 });
    const N = 50_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) void inner();
    const t1 = performance.now();
    for (let i = 0; i < N; i++) void wrapped(`${URL0}/rest/v1/x`);
    const t2 = performance.now();
    const perCallUs = (((t2 - t1) - (t1 - t0)) / N) * 1000;
    // Loose bound (CI machines vary); measured values are documented in docs/performance/.
    expect(perCallUs).toBeLessThan(20);
  });
});

describe("visits", () => {
  it("does nothing while disabled", () => {
    setPerfEnabledForTests(false);
    expect(perfBeginVisit("x", false)).toBeNull();
    perfSetReady(null, true);
    expect(perfSnapshot().visits).toHaveLength(0);
  });

  it("records content time and loading periods after content", () => {
    setPerfEnabledForTests(true);
    const id = perfBeginVisit("athlete.home", false);
    perfSetReady(id, true);
    perfSetReady(id, false);
    perfSetReady(id, true);
    const v = perfSnapshot().visits[0]!;
    expect(v.contentAt).not.toBeNull();
    expect(v.notReady).toHaveLength(1);
    expect(v.notReady[0]!.end).not.toBeNull();
  });

  it("a nested component visit and its screen share the same tap", () => {
    setPerfEnabledForTests(true);
    perfNotePointerDown();
    perfBeginVisit("session.roster", false);
    perfBeginVisit("coach.session", false);
    const [roster, screen] = perfSnapshot().visits;
    expect(roster!.tapAt).not.toBeNull();
    expect(screen!.tapAt).toBe(roster!.tapAt);
  });

  it("a screen that is ready at focus has content immediately", () => {
    setPerfEnabledForTests(true);
    perfBeginVisit("manager.home", true);
    const s = perfSnapshot().summaries[0]!;
    expect(s.focusToContentMs).toBe(0);
  });
});

describe("analysis", () => {
  const r = (id: number, start: number, end: number, visitId: number | null = 1, endpoint = "rest:x"): PerfRequestRecord => ({
    id,
    endpoint,
    method: "GET",
    start,
    end,
    status: 200,
    visitId,
  });

  it("parallel requests share one level; each request issued after a response adds one", () => {
    expect(sequentialDepth([])).toBe(0);
    expect(sequentialDepth([r(1, 0, 100), r(2, 0, 100), r(3, 5, 120)])).toBe(1);
    expect(sequentialDepth([r(1, 0, 100), r(2, 101, 200), r(3, 201, 300)])).toBe(3);
    expect(sequentialDepth([r(1, 0, 100), r(2, 0, 300), r(3, 101, 200), r(4, 301, 400)])).toBe(3);
  });

  it("summarizes a visit: tap→content, requests and depth before content, loading time", () => {
    const visit: PerfVisitRecord = {
      id: 1,
      screen: "athlete.session",
      focusAt: 1000,
      tapAt: 950,
      readyAtFocus: false,
      contentAt: 1400,
      notReady: [{ start: 2000, end: 2300 }],
    };
    const reqs = [r(1, 1010, 1200, 1, "rest:training_sessions"), r(2, 1201, 1390, 1, "rpc:active_registration_counts"), r(3, 1500, 1600), r(4, 1020, 1100, 2)];
    const s = summarizeVisit(visit, reqs);
    expect(s).toMatchObject({
      tapToContentMs: 450,
      focusToContentMs: 400,
      requestsBeforeContent: 2,
      depthBeforeContent: 2,
      requestsInWindow: 3,
      settledMs: 600,
      notReadyMs: 300,
    });
    expect(s.endpoints).toEqual({ "rest:training_sessions": 1, "rpc:active_registration_counts": 1, "rest:x": 1 });
  });

  it("startup = requests before the first screen visit", () => {
    const s = summarizeStartup([r(1, 10, 200, null, "auth:user"), r(2, 201, 400, null, "rest:profiles"), r(3, 500, 600, 1)]);
    expect(s).toMatchObject({ requests: 2, depth: 2, settledMs: 400, endpoints: { "auth:user": 1, "rest:profiles": 1 } });
  });
});
