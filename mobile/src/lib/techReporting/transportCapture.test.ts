import { TechnicalReporter } from "./reporter";
import { MONITORING_REPORT_PATH, classifyHttpStatus, describeEndpoint, withTransportCapture } from "./transportCapture";
import type { TechnicalErrorInput } from "./types";

const URL0 = "https://proj.supabase.co";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-test": "kept" } });
}

function setup(script: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const reports: TechnicalErrorInput[] = [];
  const inner = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => script(typeof input === "string" ? input : String((input as URL).href ?? (input as Request).url), init));
  const wrapped = withTransportCapture(inner as never, { supabaseUrl: URL0, report: (r) => reports.push(r) });
  return { wrapped, inner, reports };
}

describe("endpoint description is safe and stable", () => {
  it("maps URLs to families/names without query strings or dynamic segments", () => {
    expect(describeEndpoint(`${URL0}/rest/v1/rpc/register_for_session?x=1#f`, URL0)).toMatchObject({ family: "rpc", name: "register_for_session" });
    expect(describeEndpoint(`${URL0}/rest/v1/profiles?select=*&phone=0501234567`, URL0)).toMatchObject({ family: "rest", name: "profiles" });
    expect(describeEndpoint(`${URL0}/auth/v1/token?grant_type=password`, URL0)).toMatchObject({ family: "auth", name: "token" });
    expect(describeEndpoint(`${URL0}/functions/v1/staff-confirm-email`, URL0)).toMatchObject({ family: "edge", name: "staff-confirm-email" });
    expect(describeEndpoint(`${URL0}/storage/v1/object/sign/document-pdfs/some/file.pdf`, URL0)).toEqual({ family: "storage", path: "/storage/v1/object/sign/document-pdfs/some/file.pdf" });
    expect(describeEndpoint(`${URL0}/rest/v1/rpc/Bad Name`, URL0)?.name).toBeUndefined();
    expect(describeEndpoint(`${URL0}x/rest/v1/profiles`, URL0)).toBeNull();
    expect(describeEndpoint("https://example.com/rest/v1/profiles", URL0)).toBeNull();
    expect(describeEndpoint(`${URL0}/rest/v1/profiles`, "")).toBeNull();
  });
  it("accepts URL and Request-like inputs", () => {
    expect(describeEndpoint(new URL(`${URL0}/rest/v1/rpc/f`), URL0)?.family).toBe("rpc");
    expect(describeEndpoint(new Request(`${URL0}/rest/v1/rpc/f`), URL0)?.family).toBe("rpc");
  });
});

describe("status classification (only unambiguous technical failures)", () => {
  it.each([
    ["rpc", 500, "error"], ["rpc", 502, "warning"], ["rpc", 503, "warning"], ["rpc", 504, "warning"], ["auth", 500, "error"],
    ["edge", 500, "error"], ["edge", 595, "error"], ["storage", 503, "warning"], ["rest", 408, "warning"], ["rpc", 429, "warning"], ["edge", 429, "warning"],
  ] as const)("%s %s is reported (%s)", (family, status, sev) => {
    expect(classifyHttpStatus(family, status)).toMatchObject({ report: true, severity: sev });
  });
  it.each([
    ["auth", 400], ["auth", 401], ["auth", 403], ["auth", 422], ["auth", 429], ["rest", 400], ["rest", 401], ["rest", 403], ["rest", 404], ["rest", 406], ["rest", 409],
    ["rpc", 400], ["rpc", 404], ["rpc", 409], ["edge", 400], ["edge", 401], ["edge", 403], ["edge", 404], ["edge", 405], ["edge", 409], ["storage", 404], ["rest", 301], ["rest", 200],
  ] as const)("%s %s is deliberately NOT reported at this layer", (family, status) => {
    expect(classifyHttpStatus(family, status).report).toBe(false);
  });
});

describe("transport capture behaviour", () => {
  it("a network rejection produces exactly one candidate report and rethrows the same error object", async () => {
    const err = new TypeError("Network request failed");
    const { wrapped, reports } = setup(() => { throw err; });
    await expect(wrapped(`${URL0}/rest/v1/rpc/register_for_session`, { method: "POST" })).rejects.toBe(err);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ operation: "transport/rpc:register_for_session", errorCode: "network_error", severity: "info", context: { phase: "transport", rpc: "register_for_session", retryable: true } });
  });

  it.each([500, 502, 503, 504])("a %s response produces exactly one report and the same Response object is returned", async (status) => {
    let sent: Response | undefined;
    const { wrapped, reports } = setup(() => (sent = jsonResponse(status, { message: "boom" })));
    const res = await wrapped(`${URL0}/rest/v1/rpc/f`);
    expect(res).toBe(sent);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ operation: "transport/rpc:f", errorCode: `http_${status}`, context: { http_status: status } });
  });

  it("HTTP 2xx produces no report; the body is neither read nor consumed", async () => {
    const { wrapped, reports } = setup(() => jsonResponse(200, [{ id: 1 }]));
    const res = await wrapped(`${URL0}/rest/v1/profiles?select=*`);
    expect(reports).toEqual([]);
    expect(res.bodyUsed).toBe(false);
    expect(await res.json()).toEqual([{ id: 1 }]);
  });

  it("never clones, reads or parses any response body (2xx or error)", async () => {
    const spies = ["clone", "json", "text", "arrayBuffer", "blob", "formData"].map((m) => jest.spyOn(Response.prototype as never, m as never));
    try {
      for (const status of [200, 400, 503]) {
        const { wrapped } = setup(() => jsonResponse(status, { ok: false, error: "x" }));
        await wrapped(`${URL0}/rest/v1/rpc/f`);
      }
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it.each([{ ok: false, error: "full" }, { ok: false, error: "unexpected_internal_code" }, { ok: false, error: 'duplicate key value violates unique constraint "x"' }])(
    "HTTP 2xx with RPC body %j produces no transport report (Phase 3C owns it) and the body stays unread",
    async (body) => {
      const { wrapped, reports } = setup(() => jsonResponse(200, body));
      const res = await wrapped(`${URL0}/rest/v1/rpc/register_for_session`, { method: "POST" });
      expect(reports).toEqual([]);
      expect(res.bodyUsed).toBe(false);
      expect(await res.json()).toEqual(body);
    }
  );

  it.each([
    ["auth wrong password", `${URL0}/auth/v1/token?grant_type=password`, 400],
    ["auth signup validation", `${URL0}/auth/v1/signup`, 422],
    ["auth refresh rejected", `${URL0}/auth/v1/token?grant_type=refresh_token`, 400],
    ["auth session expired", `${URL0}/auth/v1/user`, 401],
    ["auth rate limit", `${URL0}/auth/v1/recover`, 429],
    ["business exception token (RAISE -> 400)", `${URL0}/rest/v1/athlete_account_payments`, 400],
    ["unique conflict", `${URL0}/rest/v1/session_registrations`, 409],
    [".single() miss", `${URL0}/rest/v1/profiles?select=*`, 406],
    ["edge function business 4xx", `${URL0}/functions/v1/staff-confirm-email`, 403],
  ])("expected product state is NOT reported: %s", async (_n, url, status) => {
    const { wrapped, reports } = setup(() => jsonResponse(status));
    await wrapped(url);
    expect(reports).toEqual([]);
  });

  it("auth 5xx IS reported (the identity provider itself failing is technical)", async () => {
    const { wrapped, reports } = setup(() => jsonResponse(503));
    await wrapped(`${URL0}/auth/v1/token?grant_type=password`);
    expect(reports).toHaveLength(1);
    expect(reports[0].operation).toBe("transport/auth:token");
  });

  it("a request recovered by an inner refresh-and-retry is judged on its final outcome", async () => {
    let calls = 0;
    const { wrapped, reports } = setup(() => { calls++; return jsonResponse(200); }); // inner already retried internally
    await wrapped(`${URL0}/rest/v1/profiles`);
    expect(calls).toBe(1);
    expect(reports).toEqual([]);
  });

  it("cancellations (AbortError), non-Supabase hosts and unknown Supabase paths are not reported", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const a = setup(() => { throw abort; });
    await expect(a.wrapped(`${URL0}/rest/v1/profiles`)).rejects.toBe(abort);
    expect(a.reports).toEqual([]);
    const b = setup(() => { throw new TypeError("x"); });
    await expect(b.wrapped("https://example.com/api")).rejects.toThrow("x");
    await expect(b.wrapped(`${URL0}/somewhere/else`)).rejects.toThrow("x");
    expect(b.reports).toEqual([]);
  });

  it("nothing from the URL query string or headers can leak into a report", async () => {
    const { wrapped, reports } = setup(() => { throw new TypeError(`Network request failed for ${URL0}/rest/v1/profiles?email=a@b.com&token=eyJhbGciOi.abcdefghijk.lmnopqrstuv`); });
    await expect(wrapped(`${URL0}/rest/v1/profiles?email=a@b.com`, { headers: { Authorization: "Bearer eyJabc.defghi.jklmno", apikey: "secret-key-value" } })).rejects.toThrow();
    const r = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}) });
    r.report(reports[0]);
    const text = JSON.stringify(r.getObserved());
    expect(text).not.toMatch(/a@b\.com|eyJ|secret-key-value|Authorization|apikey|email=|token=/i);
  });

  it("a throwing report function never changes the outcome", async () => {
    const inner = jest.fn(async () => jsonResponse(503));
    const wrapped = withTransportCapture(inner as never, { supabaseUrl: URL0, report: () => { throw new Error("reporter bug"); } });
    const res = await wrapped(`${URL0}/rest/v1/rpc/f`);
    expect(res.status).toBe(503);
    const err = new TypeError("net");
    const w2 = withTransportCapture((async () => { throw err; }) as never, { supabaseUrl: URL0, report: () => { throw new Error("reporter bug"); } });
    await expect(w2(`${URL0}/rest/v1/rpc/f`)).rejects.toBe(err);
  });
});

describe("recursion protection", () => {
  it("failures of the monitoring report request are never reported", async () => {
    const a = setup(() => { throw new TypeError("offline"); });
    await expect(a.wrapped(`${URL0}${MONITORING_REPORT_PATH}`, { method: "POST" })).rejects.toThrow("offline");
    const b = setup(() => jsonResponse(503));
    await b.wrapped(`${URL0}${MONITORING_REPORT_PATH}?x=1`, { method: "POST" });
    expect(a.reports).toEqual([]);
    expect(b.reports).toEqual([]);
  });

  it("business request fails -> reporter delivers -> monitoring request fails -> no second report, no recursion, original failure unchanged", async () => {
    const reporter = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}) });
    const businessErr = new TypeError("Network request failed");
    let monitoringCalls = 0;
    const inner = jest.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith(MONITORING_REPORT_PATH)) { monitoringCalls++; throw new TypeError("monitoring endpoint unreachable"); }
      throw businessErr;
    });
    const wrapped = withTransportCapture(inner as never, { supabaseUrl: URL0, report: (r) => reporter.report(r) });
    // the future deliverer: sends through the SAME wrapped fetch
    reporter.setDeliverer(() => wrapped(`${URL0}${MONITORING_REPORT_PATH}`, { method: "POST" }));
    await expect(wrapped(`${URL0}/rest/v1/rpc/register_for_session`, { method: "POST" })).rejects.toBe(businessErr);
    await new Promise((r) => setTimeout(r, 10));
    expect(monitoringCalls).toBe(1);
    expect(reporter.getObserved()).toHaveLength(1);
    expect(reporter.getObserved()[0].report.operation).toBe("transport/rpc:register_for_session");
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("flood control end-to-end", () => {
  it("repeated identical network failures are coalesced into one observation", async () => {
    const reporter = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}) });
    const wrapped = withTransportCapture((async () => { throw new TypeError("Network request failed"); }) as never, { supabaseUrl: URL0, report: (r) => reporter.report(r) });
    for (let i = 0; i < 100; i++) await expect(wrapped(`${URL0}/rest/v1/rpc/f`)).rejects.toThrow();
    expect(reporter.getObserved()).toHaveLength(1);
    expect(reporter.getObserved()[0].count).toBe(100);
  });

  it("concurrent failures do not corrupt reporter state", async () => {
    const reporter = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}), maxReportsPerWindow: 1000 });
    const wrapped = withTransportCapture((async (input: RequestInfo | URL) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      if (String(input).includes("/auth/")) return jsonResponse(503);
      throw new TypeError("Network request failed");
    }) as never, { supabaseUrl: URL0, report: (r) => reporter.report(r) });
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) calls.push(wrapped(`${URL0}/rest/v1/rpc/f${i % 3}`).catch(() => "rejected"));
    for (let i = 0; i < 40; i++) calls.push(wrapped(`${URL0}/auth/v1/token`).then(() => "ok"));
    const out = await Promise.all(calls);
    expect(out.filter((x) => x === "rejected")).toHaveLength(60);
    expect(out.filter((x) => x === "ok")).toHaveLength(40);
    const obs = reporter.getObserved();
    expect(obs.map((o) => o.report.operation).sort()).toEqual(["transport/auth:token", "transport/rpc:f0", "transport/rpc:f1", "transport/rpc:f2"]);
    expect(obs.reduce((n, o) => n + o.count, 0)).toBe(100);
  });
});
