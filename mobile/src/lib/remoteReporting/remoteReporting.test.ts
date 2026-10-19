/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { classifyRpcOutcome } from "../rpcOutcomes/classify";
import { installRpcOutcomeObserver, RpcOutcomeObserver } from "../rpcOutcomes/observer";
import { withTransportCapture } from "../techReporting/transportCapture";
import { SERVER_ALLOWLIST, isAllowlisted } from "./allowlist";
import { REMOTE_TECHNICAL_REPORTING_ENABLED } from "./config";
import { createRpcDeliverer, type Deliverer, type DeliveryOutcome } from "./delivery";
import { isValidWirePayload, mapOutcome, mapTransport, transportCandidateFrom, FIXED_MESSAGES, type OutcomeCandidate, type WirePayload } from "./eligibility";
import { candidateFromEvent, remoteReporting, startRemoteReporting } from "./index";
import { RemoteReportingPipeline } from "./pipeline";
import { resetServerReportingFlagForTests } from "./serverFlag";

afterEach(() => {
  // startRemoteReporting's server-flag singleton holds a setInterval; without this, repeated calls
  // across tests leak timers (and across-test flag-state bleed, since it's a module-level singleton).
  resetServerReportingFlagForTests();
});

// Monitoring Phase 3E.3: the client pipeline (classification -> eligibility -> payload -> flood control -> delivery -> breaker),
// reporting OFF in production. Everything enabled here is enabled by injection into a private instance, never through the build gate.

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src/lib/remoteReporting");
const URL0 = "https://proj.supabase.co";
const MIG = path.resolve(ROOT, "../supabase/migrations/20261015100000_system_monitoring_client_allowlist.sql");
const BUILD = () => ({ appVersion: "1.2.3", build: "45", platform: "web" as const, env: "prod" });
const WIRE_BUILD = { app_version: "1.2.3", build: "45", platform: "web", env: "prod" };
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function mkPipeline(over: { enabled?: boolean; deliver?: Deliverer | null; limits?: ConstructorParameters<typeof RemoteReportingPipeline>[0]["limits"]; clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: 1_000_000 };
  const sent: WirePayload[] = [];
  const deliver: Deliverer = over.deliver === undefined
    ? async (p) => { sent.push(p); return { kind: "server", accepted: true }; }
    : (over.deliver as Deliverer);
  const p = new RemoteReportingPipeline({ enabled: () => over.enabled !== false, deliver: over.deliver === null ? null : deliver, now: () => clock.t, buildInfo: BUILD, limits: over.limits, schedule: (fn) => fn() });
  return { p, sent, clock };
}
const tech = (operation: string, code: string): OutcomeCandidate => ({ kind: "rpc_result", operation, code, cls: classifyRpcOutcome(operation, code).class });
const GOOD = tech("register_for_session", "no_profile");

// one candidate per allowlist tuple (distinct), used for flood tests and the exhaustive mapping test
function candidateFor(t: readonly [string, string, string]): OutcomeCandidate | { transport: { family: string; status: number } } {
  const [op, cls, code] = t;
  if (cls === "RpcOutcome") return { kind: "rpc_result", operation: op.slice(4), code, cls: "technical" };
  if (cls === "RpcReason") return { kind: "rpc_reason", operation: op.slice(4), code, cls: "technical" };
  if (cls === "PostgrestError") return { kind: "postgrest", operation: "some_rpc", code, cls: "technical", raised: false };
  return { transport: { family: "rpc", status: Number(code.slice(5)) } };
}

describe("A. the feature is OFF by construction", () => {
  it("the build gate is false and is a plain constant (no env, storage, query-string or remote-config override)", () => {
    expect(REMOTE_TECHNICAL_REPORTING_ENABLED).toBe(false);
    const src = fs.readFileSync(path.join(SRC, "config.ts"), "utf8");
    expect(src).toMatch(/REMOTE_TECHNICAL_REPORTING_ENABLED: boolean = false;/);
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/process\.env|localStorage|AsyncStorage|SecureStore|Constants|location|search|getItem/);
  });

  it("a disabled pipeline does no work at all: nothing mapped, queued or delivered, whatever is submitted", async () => {
    const calls: unknown[] = [];
    const { p } = mkPipeline({ enabled: false, deliver: async (x) => { calls.push(x); return { kind: "server", accepted: true }; } });
    p.onAuth("SIGNED_IN", true);
    for (let i = 0; i < 50; i++) { p.submit(GOOD); p.submitTransport({ operation: "transport/rpc:x", errorClass: "HttpError", errorCode: "http_503", context: { http_status: 503 } }); }
    await settle();
    expect(calls).toEqual([]);
    expect(p.getStats()).toMatchObject({ submitted: 0, sent: 0, pending: 0 });
    // Auth tracking is intentionally independent of the flag (see "G. auth/flag ordering" below): a real
    // sign-in is recorded as signed-in even while the flag is currently false. "Disabled pipeline does no
    // work" is enforced by submit()/submitTransport() gating on enabled(), not by withholding signedIn.
    expect(p.isSignedIn()).toBe(true);
  });

  it("the pipeline is gated by the server flag, not the build constant: startRemoteReporting installs plumbing unconditionally, but nothing is ever submitted until the server flag resolves true", () => {
    const client = { rpc: jest.fn(() => Promise.resolve({ data: false, error: null })), auth: { onAuthStateChange: jest.fn() } };
    expect(startRemoteReporting(client)).toBe(true);
    expect(client.auth.onAuthStateChange).toHaveBeenCalled();
    remoteReporting.onAuth("SIGNED_IN", true);
    remoteReporting.submit(GOOD);
    // Synchronous: the flag's async refresh() has not resolved yet, so it is still at its
    // fail-closed default (false) - nothing is submitted even though the plumbing is installed.
    expect(remoteReporting.getStats().submitted).toBe(0);
  });

  it("supabase.ts starts the pipeline only through the gated entry point and never constructs a deliverer itself", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/supabase.ts"), "utf8");
    expect(src).toMatch(/startRemoteReporting\(supabase\);/);
    expect(src).not.toMatch(/createRpcDeliverer|setDeliverer|report_client_error|service_role/);
    expect(src).toMatch(/if \(typeof __DEV__ !== "undefined" && __DEV__\) \{\s*installRpcOutcomeObserver\(supabase\);\s*\}/);
  });

  it("zero report_client_error requests through the real client wiring while the feature is off (successes, business, technical, 5xx)", async () => {
    const reqs: string[] = [];
    const base = async (input: RequestInfo | URL): Promise<Response> => {
      const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
      reqs.push(u);
      if (u.includes("/rpc/boom")) return new Response("{}", { status: 503 });
      if (u.includes("/rpc/tech")) return new Response(JSON.stringify({ ok: false, error: "no_profile" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = createClient(URL0, "anon", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: (r) => remoteReporting.submitTransport(r) }) as never } });
    startRemoteReporting(c);
    await c.rpc("ok"); await c.rpc("tech"); await c.rpc("boom");
    await settle();
    expect(reqs.filter((u) => u.includes("report_client_error"))).toEqual([]);
    // startRemoteReporting also fires one system_client_reporting_enabled flag read (fire-and-forget,
    // not awaited above) in addition to the three deliberate business calls below.
    expect(reqs.filter((u) => !u.includes("system_client_reporting_enabled")).length).toBe(3);
  });
});

describe("B. eligibility and the exact server allowlist", () => {
  it("the client table equals the 58-rule server seed (drift check, both directions)", () => {
    const sql = fs.readFileSync(MIG, "utf8");
    const seed = [...sql.matchAll(/^\s*\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '(?:[^']|'')*'\),?$/gm)].map((m) => `${m[1]}|${m[2]}|${m[3]}`).sort();
    expect(seed).toHaveLength(58);
    expect(SERVER_ALLOWLIST.map((t) => t.join("|")).sort()).toEqual(seed);
  });

  it("every allowlisted tuple is producible by exactly one candidate shape, maps to exactly itself and passes the server validator", () => {
    for (const t of SERVER_ALLOWLIST) {
      const c = candidateFor(t);
      const d = "transport" in c ? mapTransport({ family: c.transport.family, status: c.transport.status, name: "x_rpc" }) : mapOutcome(c);
      expect(d).not.toBeNull();
      expect([d!.operation, d!.error_class, d!.error_code]).toEqual([...t]);
      expect(isValidWirePayload({ ...d!, ...WIRE_BUILD })).toBe(true);
    }
  });

  it("business, authorization, uncertain and unknown outcomes are never eligible", () => {
    for (const [op, code] of [["register_for_session", "full"], ["register_for_session", "forbidden"], ["cancel_registration", "update_failed"], ["edit_subscription_version", "concurrent_modification"], ["register_for_session", "brand_new_code"], ["register_for_session", "<non_code>"]])
      expect(mapOutcome(tech(op, code))).toBeNull();
    // even if a caller CLAIMS technical for a tuple that is not allowlisted: the server table is the second gate
    expect(mapOutcome({ kind: "rpc_result", operation: "register_for_session", code: "full", cls: "technical" })).toBeNull();
    expect(mapOutcome({ kind: "rpc_result", operation: "register_for_session", code: "no_profile", cls: "business" })).toBeNull();
    expect(mapOutcome({ kind: "rpc_result", operation: "register_for_session", code: "no_profile", cls: "unknown" })).toBeNull();
  });

  it("technical HTTP 400 outcomes: RAISE tokens map to the registry tuple, database codes to rpc/postgrest with the RPC name in context", () => {
    const raised = mapOutcome({ kind: "postgrest", operation: "update_session_note", code: "session_not_found", cls: "technical", raised: true })!;
    expect([raised.operation, raised.error_class, raised.error_code]).toEqual(["rpc/update_session_note", "RpcOutcome", "session_not_found"]);
    const db = mapOutcome({ kind: "postgrest", operation: "edit_subscription_version", code: "21000", cls: "technical", raised: false })!;
    expect([db.operation, db.error_class, db.error_code, db.context.rpc, db.context.sqlstate, db.context.phase]).toEqual(["rpc/postgrest", "PostgrestError", "21000", "edit_subscription_version", "21000", "rpc_error"]);
    // the server operation never carries an RPC name that has no exact rule
    expect(db.operation).not.toContain("edit_subscription_version");
  });

  it("expected / non-allowlisted HTTP 400 and arbitrary codes are not eligible", () => {
    for (const code of ["23505", "42501", "22P02", "PGRST116", "PGRST301", "ZZ001", "P0002", "23503"])
      expect(mapOutcome({ kind: "postgrest", operation: "register_for_session", code, cls: "technical", raised: false })).toBeNull();
    expect(mapOutcome({ kind: "postgrest", operation: "waitlist_counts", code: "forbidden", cls: "authorization_validation", raised: true })).toBeNull();
    expect(mapOutcome({ kind: "postgrest", operation: "register_for_session", code: "21000", cls: "uncertain", raised: false })).toBeNull();
    expect(mapOutcome({ kind: "postgrest", operation: "Bad Name!", code: "21000", cls: "technical", raised: false })).toBeNull();
  });

  it("transport: only 500 (transport/server) and 502/503/504 (transport/infra) are eligible", () => {
    const m = (status: number) => mapTransport({ family: "rpc", name: "register_for_session", status });
    expect([m(500)!.operation, m(500)!.error_code]).toEqual(["transport/server", "http_500"]);
    for (const s of [502, 503, 504]) expect([m(s)!.operation, m(s)!.error_code, m(s)!.context.retryable]).toEqual(["transport/infra", `http_${s}`, true]);
    for (const s of [0, 200, 400, 401, 403, 404, 408, 409, 422, 429, 501, 505, 511, 520, 522, 599]) expect(m(s)).toBeNull();
    expect(mapTransport({ family: "rpc", status: 503.5 })).toBeNull();
    expect(mapTransport({ family: "rpc", name: "report_client_error", status: 503 })).toBeNull();
  });

  it("transportCandidateFrom accepts only the Phase 3B HttpError shape (network errors, 408/429 reports and junk are not candidates)", () => {
    expect(transportCandidateFrom({ operation: "transport/rpc:register_for_session", errorClass: "HttpError", errorCode: "http_503", context: { http_status: 503 } })).toEqual({ family: "rpc", name: "register_for_session", status: 503 });
    expect(transportCandidateFrom({ operation: "transport/auth:token", errorClass: "HttpError", errorCode: "http_500", context: { http_status: 500 } })).toEqual({ family: "auth", name: "token", status: 500 });
    for (const bad of [
      { operation: "transport/rpc:x", errorClass: "NetworkError", errorCode: "network_error", context: {} },
      { operation: "transport/rpc:x", errorClass: "HttpError", errorCode: "http_503", context: { http_status: 500 } },
      { operation: "ui/x", errorClass: "HttpError", errorCode: "http_503", context: { http_status: 503 } },
      null, undefined, 5, "x", {},
    ]) expect(transportCandidateFrom(bad)).toBeNull();
    // 408 / 429 pass the candidate parser but are not approved by the mapper
    expect(mapTransport(transportCandidateFrom({ operation: "transport/rpc:x", errorClass: "HttpError", errorCode: "http_429", context: { http_status: 429 } })!)).toBeNull();
  });

  it("the reporting RPC itself is never eligible, in any channel", () => {
    expect(mapOutcome({ kind: "rpc_result", operation: "report_client_error", code: "no_profile", cls: "technical" })).toBeNull();
    expect(mapOutcome({ kind: "postgrest", operation: "report_client_error", code: "21000", cls: "technical", raised: false })).toBeNull();
    expect(mapOutcome({ kind: "postgrest", operation: "system_report_trusted", code: "21000", cls: "technical", raised: false })).toBeNull();
    expect(isAllowlisted("rpc/report_client_error", "RpcOutcome", "no_profile")).toBe(false);
  });
});

describe("C. payload contract and privacy", () => {
  it("only server-accepted fields, fixed messages, bounded size, no ids/PII/arguments", () => {
    const { p, sent } = mkPipeline();
    p.onAuth("SIGNED_IN", true);
    p.submit({ kind: "postgrest", operation: "edit_subscription_version", code: "21000", cls: "technical", raised: false });
    return settle().then(() => {
      expect(sent).toHaveLength(1);
      const x = sent[0];
      expect(Object.keys(x).sort()).toEqual(["app_version", "build", "context", "env", "error_class", "error_code", "message", "operation", "platform", "severity"]);
      expect(x.severity).toBe("warning");
      expect(x.message).toBe(FIXED_MESSAGES.PostgrestError);
      expect(Object.keys(x.context).sort()).toEqual(["phase", "rpc", "sqlstate"]);
      expect(JSON.stringify(x).length).toBeLessThan(600);
      expect(JSON.stringify(x)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}|eyJ|Bearer|password|token|http:|https:/i);
      expect(isValidWirePayload(x)).toBe(true);
    });
  });

  it("the wire validator mirrors the server: unexpected keys, bad patterns, nested context and non-allowlisted tuples are refused", () => {
    const ok = { ...mapOutcome(GOOD)!, ...WIRE_BUILD };
    expect(isValidWirePayload(ok)).toBe(true);
    for (const bad of [
      { ...ok, user_id: "x" }, { ...ok, fingerprint_key: "k" }, { ...ok, stack: "s" }, { ...ok, source: "cron" }, { ...ok, platform: "server" },
      { ...ok, context: { rpc: { a: 1 } } }, { ...ok, message: "x".repeat(301) }, { ...ok, severity: "CRITICAL!" }, { ...ok, error_code: "full" },
      { ...ok, operation: "rpc/not_an_rpc" }, { ...ok, app_version: "1 0" }, [], null, "x",
    ]) expect(isValidWirePayload(bad)).toBe(false);
  });

  it("caller-provided metadata never reaches the payload: only fixed fields derive from the candidate", () => {
    const c = { ...GOOD, secret: "alice@example.com", userId: "8a7c2f10-1111-2222-3333-444455556666", args: { a: 1 } } as unknown as OutcomeCandidate;
    const d = mapOutcome(c)!;
    expect(JSON.stringify(d)).not.toMatch(/alice|8a7c2f10|args|secret/);
  });

  it("an unexpected build string cannot make the whole report fail: optional fields are dropped, the report is kept", async () => {
    const sent: WirePayload[] = [];
    const p = new RemoteReportingPipeline({ enabled: () => true, deliver: async (x) => { sent.push(x); return { kind: "server", accepted: true }; }, buildInfo: () => ({ appVersion: "1 2 3", build: "ok", platform: "web", env: "prod" }), schedule: (f) => f() });
    p.onAuth("SIGNED_IN", true); p.submit(GOOD); await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("app_version");
    expect(isValidWirePayload(sent[0])).toBe(true);
  });
});

describe("D. flood control and bounded memory", () => {
  it("identical failures are coalesced for 30 minutes, then reported again", async () => {
    const { p, sent, clock } = mkPipeline();
    p.onAuth("SIGNED_IN", true);
    for (let i = 0; i < 20; i++) p.submit(GOOD);
    await settle();
    expect(sent).toHaveLength(1);
    expect(p.getStats().coalesced).toBe(19);
    clock.t += 29 * 60_000; p.submit(GOOD); await settle(); expect(sent).toHaveLength(1);
    clock.t += 2 * 60_000; p.submit(GOOD); await settle(); expect(sent).toHaveLength(2);
  });

  it("at most 5 reports per 10 minutes and 20 per hour", async () => {
    const { p, sent, clock } = mkPipeline();
    p.onAuth("SIGNED_IN", true);
    const tuples = SERVER_ALLOWLIST.filter((t) => t[1] === "PostgrestError");
    for (const t of tuples.slice(0, 12)) { p.submit(candidateFor(t) as OutcomeCandidate); await settle(); }
    expect(sent).toHaveLength(5);
    expect(p.getStats().droppedByCap).toBe(7);
    // the 10-minute window slides: 11 minutes later 5 more are admitted
    clock.t += 11 * 60_000;
    for (const t of tuples.slice(5, 12)) { p.submit(candidateFor(t) as OutcomeCandidate); await settle(); }
    expect(sent).toHaveLength(10);
  });

  it("never more than 20 admissions in any rolling hour", async () => {
    const { p, sent, clock } = mkPipeline({ limits: { coalesceMs: 1 } });
    p.onAuth("SIGNED_IN", true);
    const stamps: number[] = [];
    for (let i = 0; i < 200; i++) {
      clock.t += 2 * 60_000; // one candidate every 2 minutes for ~6.6 hours
      const before = sent.length;
      p.submit(candidateFor(SERVER_ALLOWLIST[i % 20 + 24]) as OutcomeCandidate);
      await settle();
      if (sent.length > before) stamps.push(clock.t);
    }
    for (const s of stamps) expect(stamps.filter((x) => x > s - 3_600_000 && x <= s).length).toBeLessThanOrEqual(20);
    for (const s of stamps) expect(stamps.filter((x) => x > s - 600_000 && x <= s).length).toBeLessThanOrEqual(5);
    expect(stamps.length).toBeGreaterThan(20);
  });

  it("at most 10 pending in memory and exactly one in-flight delivery", async () => {
    let inflight = 0, maxInflight = 0;
    const release: (() => void)[] = [];
    const deliver: Deliverer = () => new Promise<DeliveryOutcome>((res) => { inflight++; maxInflight = Math.max(maxInflight, inflight); release.push(() => { inflight--; res({ kind: "server", accepted: true }); }); });
    const { p } = mkPipeline({ deliver, limits: { perTenMinutes: 1000, perHour: 1000, deliveryTimeoutMs: 60_000 } });
    p.onAuth("SIGNED_IN", true);
    const tuples = SERVER_ALLOWLIST.slice(0, 40);
    for (const t of tuples) { p.submit(candidateFor(t) as OutcomeCandidate); }
    await settle();
    expect(inflight).toBe(1);
    expect(p.getStats().pending).toBeLessThanOrEqual(10);
    expect(p.getStats().droppedQueueFull).toBeGreaterThan(0);
    while (release.length) { release.shift()!(); await settle(); }
    expect(maxInflight).toBe(1);
  });

  it("tracking structures stay bounded under a flood of distinct failures", async () => {
    const { p, clock } = mkPipeline({ limits: { perTenMinutes: 1e9, perHour: 1e9, maxKeys: 20 } });
    p.onAuth("SIGNED_IN", true);
    for (let i = 0; i < 3000; i++) { clock.t += 1; p.submit({ kind: "postgrest", operation: `rpc_${i}`, code: "21000", cls: "technical", raised: false }); }
    await settle();
    expect(p.getStats().pending).toBeLessThanOrEqual(10);
    expect(p.getStats().coalesced).toBeGreaterThan(2900);
  });

  it("nothing is persisted: no storage, file, cookie or network API in the pipeline sources", () => {
    for (const f of ["pipeline.ts", "eligibility.ts", "allowlist.ts", "config.ts", "index.ts"]) {
      const code = fs.readFileSync(path.join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/localStorage|sessionStorage|AsyncStorage|SecureStore|indexedDB|document\.cookie|require\("fs"\)|from "fs"|fetch\(|XMLHttpRequest|console\.|service_role/);
    }
  });
});

describe("E. delivery, circuit breaker and authentication lifecycle", () => {
  const out = (reason: string, retry?: number): Deliverer => async () => ({ kind: "server", accepted: false, reason, retryAfterS: retry });
  const two = async (p: RemoteReportingPipeline, clock: { t: number }) => {
    p.submit(candidateFor(SERVER_ALLOWLIST[24]) as OutcomeCandidate); await settle();
    clock.t += 31 * 60_000; // past coalescing, inside any long pause
    p.submit(candidateFor(SERVER_ALLOWLIST[25]) as OutcomeCandidate); await settle();
  };

  it("reports are delivered only with a signed-in session; not signed in => dropped (no queue)", async () => {
    const { p, sent } = mkPipeline();
    p.submit(GOOD); await settle();
    expect(sent).toHaveLength(0);
    expect(p.getStats().notSignedIn).toBe(1);
    p.onAuth("INITIAL_SESSION", false); p.submit(GOOD); await settle();
    expect(sent).toHaveLength(0);
    p.onAuth("INITIAL_SESSION", true); p.submit(GOOD); await settle();
    expect(sent).toHaveLength(1);
  });

  it("sign-out clears pending work and an in-flight result of the old session is ignored", async () => {
    let resolve!: (o: DeliveryOutcome) => void;
    const calls: WirePayload[] = [];
    const { p } = mkPipeline({ deliver: (x) => { calls.push(x); return new Promise((r) => { resolve = r; }); }, limits: { deliveryTimeoutMs: 60_000 } });
    p.onAuth("SIGNED_IN", true);
    p.submit(candidateFor(SERVER_ALLOWLIST[24]) as OutcomeCandidate); p.submit(candidateFor(SERVER_ALLOWLIST[25]) as OutcomeCandidate);
    await settle();
    expect(calls).toHaveLength(1);
    p.onAuth("SIGNED_OUT", false);
    expect(p.getStats().pending).toBe(0);
    resolve({ kind: "server", accepted: false, reason: "not_allowed" });
    await settle();
    expect(p.getStats().pausedUntil).toBe(0);           // the old session's verdict does not pause the next session
    p.onAuth("SIGNED_IN", true);
    expect(p.isSignedIn()).toBe(true);
  });

  it("token refresh keeps the session; a disabled-account verdict pauses until the next real sign-in", async () => {
    const { p, clock } = mkPipeline({ deliver: out("not_allowed") });
    p.onAuth("INITIAL_SESSION", true);
    await two(p, clock);
    expect(p.getStats().sent).toBe(1);                   // second report was held back by the pause
    p.onAuth("TOKEN_REFRESHED", true);
    expect(p.getStats().pausedUntil).toBeGreaterThan(clock.t);
    p.onAuth("SIGNED_IN", true);
    expect(p.getStats().pausedUntil).toBe(0);
  });

  it.each([
    ["disabled", 6 * 3600_000], ["unauthenticated", 6 * 3600_000], ["not_allowed", 6 * 3600_000],
  ])("server reason %s pauses delivery for 6 hours", async (reason, ms) => {
    const { p, clock } = mkPipeline({ deliver: out(reason) });
    p.onAuth("SIGNED_IN", true);
    const t0 = clock.t;
    p.submit(GOOD); await settle();
    expect(p.getStats().pausedUntil - t0).toBe(ms);
  });

  it.each(["user_quota", "throttled", "user_new_fingerprints", "global_new_fingerprints"])("server reason %s honours retry_after_s within [60s, 1h]", async (reason) => {
    const a = mkPipeline({ deliver: out(reason, 120) }); a.p.onAuth("SIGNED_IN", true); const t0 = a.clock.t; a.p.submit(GOOD); await settle();
    expect(a.p.getStats().pausedUntil - t0).toBe(120_000);
    const b = mkPipeline({ deliver: out(reason, 5) }); b.p.onAuth("SIGNED_IN", true); const t1 = b.clock.t; b.p.submit(GOOD); await settle();
    expect(b.p.getStats().pausedUntil - t1).toBe(60_000);
    const c = mkPipeline({ deliver: out(reason, 999999) }); c.p.onAuth("SIGNED_IN", true); const t2 = c.clock.t; c.p.submit(GOOD); await settle();
    expect(c.p.getStats().pausedUntil - t2).toBe(3_600_000);
  });

  it.each(["not_allowlisted", "ignored", "invalid_payload"])("server reason %s suppresses only that report key for the session, without pausing", async (reason) => {
    let n = 0;
    const { p, clock } = mkPipeline({ deliver: async () => { n++; return n === 1 ? { kind: "server", accepted: false, reason } : { kind: "server", accepted: true }; } });
    p.onAuth("SIGNED_IN", true);
    p.submit(GOOD); await settle();
    expect(p.getStats().pausedUntil).toBe(0);
    clock.t += 31 * 60_000; p.submit(GOOD); await settle();                         // same key: suppressed
    expect(n).toBe(1);
    p.submit(candidateFor(SERVER_ALLOWLIST[25]) as OutcomeCandidate); await settle();  // a different key still goes out
    expect(n).toBe(2);
  });

  it("internal server errors and failed requests back off with bounded exponential delays, and three failures pause for an hour", async () => {
    const { p, clock } = mkPipeline({ deliver: async () => ({ kind: "http", status: 500 }), limits: { perTenMinutes: 100, perHour: 100 } });
    p.onAuth("SIGNED_IN", true);
    const tuples = SERVER_ALLOWLIST.slice(24, 40);
    const pauses: number[] = [];
    for (let i = 0; i < 4; i++) {
      clock.t = Math.max(clock.t, p.getStats().pausedUntil) + 1;
      p.submit(candidateFor(tuples[i]) as OutcomeCandidate); await settle();
      pauses.push(p.getStats().pausedUntil - clock.t);
    }
    expect(pauses[0]).toBeLessThanOrEqual(60_000);
    expect(pauses[1]).toBeLessThanOrEqual(120_000);
    expect(pauses[2]).toBe(3_600_000 - 0);
    expect(Math.max(...pauses)).toBeLessThanOrEqual(3_600_000);
    expect(p.getStats().failed).toBe(4);
  });

  it("a 401/403 from the report call (no valid session) pauses until the next sign-in; a hung delivery times out and is a failure, not a hang", async () => {
    const a = mkPipeline({ deliver: async () => ({ kind: "http", status: 401 }) }); a.p.onAuth("SIGNED_IN", true); a.p.submit(GOOD); await settle();
    expect(a.p.getStats().pausedUntil - a.clock.t).toBe(6 * 3600_000);
    const b = mkPipeline({ deliver: () => new Promise<DeliveryOutcome>(() => undefined), limits: { deliveryTimeoutMs: 20 } });
    b.p.onAuth("SIGNED_IN", true); b.p.submit(GOOD);
    await new Promise((r) => setTimeout(r, 80));
    expect(b.p.getStats().failed).toBe(1);
  });

  it("a rejecting or throwing deliverer, build info or scheduler never throws into the caller", async () => {
    const boom = () => { throw new Error("x"); };
    const p1 = new RemoteReportingPipeline({ enabled: () => true, deliver: async () => { throw new Error("net"); }, buildInfo: BUILD, schedule: (f) => f() });
    p1.onAuth("SIGNED_IN", true);
    expect(() => p1.submit(GOOD)).not.toThrow();
    const p2 = new RemoteReportingPipeline({ enabled: () => true, deliver: boom as never, buildInfo: boom as never, schedule: boom });
    p2.onAuth("SIGNED_IN", true);
    expect(() => p2.submit(GOOD)).not.toThrow();
    expect(() => p2.submitTransport({ operation: boom })).not.toThrow();
    const p3 = new RemoteReportingPipeline({ enabled: boom as never, deliver: null });
    expect(() => { p3.submit(GOOD); p3.onAuth("SIGNED_IN", true); }).not.toThrow();
    await settle();
  });
});

describe("E2. the deliverer", () => {
  const client = (res: unknown | Error) => ({ rpc: jest.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))) });
  const payload = { ...mapOutcome(GOOD)!, ...WIRE_BUILD } as WirePayload;
  it("calls only report_client_error with exactly { p_payload } and never throws, whatever comes back", async () => {
    const c = client({ data: { ok: true, accepted: true, reason: null, retry_after_s: null }, error: null });
    expect(await createRpcDeliverer(c)(payload)).toEqual({ kind: "server", accepted: true, reason: undefined, retryAfterS: undefined });
    expect(c.rpc).toHaveBeenCalledWith("report_client_error", { p_payload: payload });
    expect(await createRpcDeliverer(client({ data: { accepted: false, reason: "user_quota", retry_after_s: 120 }, error: null }))(payload)).toEqual({ kind: "server", accepted: false, reason: "user_quota", retryAfterS: 120 });
    expect(await createRpcDeliverer(client({ data: null, error: { code: "PGRST301" }, status: 401 }))(payload)).toEqual({ kind: "http", status: 401 });
    expect(await createRpcDeliverer(client(new Error("network")))(payload)).toEqual({ kind: "exception" });
    expect(await createRpcDeliverer(client({ data: "garbage", error: null }))(payload)).toEqual({ kind: "exception" });
    expect(await createRpcDeliverer(null)(payload)).toEqual({ kind: "exception" });
    expect((await createRpcDeliverer(client({ data: { accepted: false, reason: "RAW DB TEXT with spaces" }, error: null }))(payload) as { reason?: string }).reason).toBeUndefined();
  });
});

describe("F. real supabase-js integration: results unchanged, exact requests, no duplicates, no recursion", () => {
  type Resp = { status: number; body: unknown };
  function setup(routes: Record<string, Resp | "network">, reportResp: Resp = { status: 200, body: { ok: true, accepted: true, reason: null, retry_after_s: null } }) {
    const reqs: { url: string; body: unknown; auth: string | null }[] = [];
    const base = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
      let body: unknown = null;
      try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      const h = init?.headers as Headers | Record<string, string> | undefined;
      const auth = h && typeof (h as Headers).get === "function" ? (h as Headers).get("authorization") : (h as Record<string, string> | undefined)?.authorization ?? null;
      reqs.push({ url: u, body, auth });
      if (u.includes("/rpc/report_client_error")) return new Response(JSON.stringify(reportResp.body), { status: reportResp.status, headers: { "content-type": "application/json" } });
      const key = Object.keys(routes).find((k) => u.includes(k));
      const r = key ? routes[key] : { status: 200, body: { ok: true } };
      if (r === "network") throw new TypeError("Network request failed");
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    };
    const { p } = mkPipeline({ deliver: null });
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const mkc = (wired: boolean) => {
      const observer = new RpcOutcomeObserver({ isEnabled: () => true, aggregate: () => false });
      const c = createClient(URL0, "anon", { ...opts, global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: (r) => { if (wired) p.submitTransport(r); } }) as never } });
      if (wired) startRemoteReporting(c, p, observer, false);
      return c;
    };
    return { p, reqs, wired: mkc(true), plain: mkc(false), reports: () => reqs.filter((r) => r.url.includes("/rpc/report_client_error")) };
  }
  const pick = (r: unknown) => { const x = r as { data: unknown; error: { message?: string; code?: string } | null; status: number }; return JSON.parse(JSON.stringify({ data: x.data, status: x.status, error: x.error ? { message: x.error.message, code: x.error.code } : null })); };
  const signIn = async (p: RemoteReportingPipeline) => { await settle(); p.onAuth("SIGNED_IN", true); };

  it("a technical 2xx outcome sends exactly one well-formed report; the caller's result is identical to the un-observed client", async () => {
    const s = setup({ "/rpc/register_for_session": { status: 200, body: { ok: false, error: "no_profile" } } });
    await signIn(s.p);
    const a = await s.plain.rpc("register_for_session", { p_session_id: "secret-session-id" });
    const b = await s.wired.rpc("register_for_session", { p_session_id: "secret-session-id" });
    expect(pick(b)).toEqual(pick(a));
    await settle();
    expect(s.reports()).toHaveLength(1);
    const body = s.reports()[0].body as { p_payload: WirePayload };
    expect(Object.keys(body)).toEqual(["p_payload"]);
    expect(body.p_payload).toMatchObject({ operation: "rpc/register_for_session", error_class: "RpcOutcome", error_code: "no_profile", severity: "warning", message: FIXED_MESSAGES.RpcOutcome, context: { phase: "rpc_result", rpc: "register_for_session" } });
    expect(JSON.stringify(s.reports()[0])).not.toMatch(/secret-session-id|p_session_id/);
  });

  it("business, authorization, uncertain, unknown results and successes send nothing", async () => {
    const s = setup({
      "/rpc/a": { status: 200, body: { ok: false, error: "full" } }, "/rpc/b": { status: 200, body: { ok: false, error: "forbidden" } },
      "/rpc/cancel_registration": { status: 200, body: { ok: false, error: "update_failed" } }, "/rpc/c": { status: 200, body: { ok: false, error: "never_seen" } }, "/rpc/d": { status: 200, body: { ok: true } },
    });
    await signIn(s.p);
    for (const fn of ["a", "b", "cancel_registration", "c", "d"]) await s.wired.rpc(fn);
    await settle();
    expect(s.reports()).toHaveLength(0);
  });

  it("technical HTTP 400 (SQLSTATE 21000) is reported as rpc/postgrest with the RPC name in context; expected 400 `forbidden` is not", async () => {
    const s = setup({
      "/rpc/edit_subscription_version": { status: 400, body: { code: "21000", message: "DELETE requires a WHERE clause" } },
      "/rpc/waitlist_counts": { status: 400, body: { code: "P0001", message: "forbidden" } },
      "/rpc/update_session_note": { status: 400, body: { code: "P0001", message: "session_not_found" } },
      "/rpc/other": { status: 400, body: { code: "23505", message: "duplicate key value violates unique constraint" } },
    });
    await signIn(s.p);
    const plain = await s.plain.rpc("edit_subscription_version");
    const wired = await s.wired.rpc("edit_subscription_version");
    expect(pick(wired)).toEqual(pick(plain));
    expect(wired.error?.message).toBe("DELETE requires a WHERE clause"); // business/technical text still reaches the UI
    await s.wired.rpc("waitlist_counts"); await s.wired.rpc("update_session_note"); await s.wired.rpc("other");
    await settle();
    const ps = s.reports().map((r) => (r.body as { p_payload: WirePayload }).p_payload);
    expect(ps.map((x) => [x.operation, x.error_class, x.error_code])).toEqual([["rpc/postgrest", "PostgrestError", "21000"], ["rpc/update_session_note", "RpcOutcome", "session_not_found"]]);
    expect(ps[0].context).toEqual({ phase: "rpc_error", rpc: "edit_subscription_version", sqlstate: "21000" });
    expect(JSON.stringify(ps)).not.toMatch(/WHERE|duplicate/);
  });

  it("transport: 503 / 502 / 504 / 500 are reported once each (no duplicate from the RPC observer); 408/429/501/520/network are not", async () => {
    const s = setup({
      "/rpc/r503": { status: 503, body: { message: "down" } }, "/rpc/r502": { status: 502, body: {} }, "/rpc/r504": { status: 504, body: {} }, "/rpc/r500": { status: 500, body: { code: "XX000", message: "x" } },
      "/rpc/r408": { status: 408, body: {} }, "/rpc/r429": { status: 429, body: {} }, "/rpc/r501": { status: 501, body: {} }, "/rpc/r520": { status: 520, body: {} }, "/rpc/net": "network",
    });
    await signIn(s.p);
    for (const fn of ["r503", "r502", "r504", "r500", "r408", "r429", "r501", "r520"]) await s.wired.rpc(fn);
    await s.wired.rpc("net");
    await settle();
    const ps = s.reports().map((r) => (r.body as { p_payload: WirePayload }).p_payload);
    expect(ps.map((x) => `${x.operation}|${x.error_code}`)).toEqual(["transport/infra|http_503", "transport/infra|http_502", "transport/infra|http_504", "transport/server|http_500"]);
    expect(ps[0].context).toEqual({ phase: "transport", http_status: 503, retryable: true, rpc: "r503" });
    expect(s.p.getStats().coalesced).toBe(0);
  });

  it("no recursion: failures of the report call itself are never reported; the report goes through the user's authenticated client path", async () => {
    const s = setup({ "/rpc/register_for_session": { status: 200, body: { ok: false, error: "no_profile" } } }, { status: 503, body: { message: "down" } });
    await signIn(s.p);
    await s.wired.rpc("register_for_session");
    await settle(); await settle();
    expect(s.reports()).toHaveLength(1);                   // the 503 of the report call did not produce another report
    expect(s.p.getStats().failed).toBe(1);
    const s2 = setup({ "/rpc/register_for_session": { status: 200, body: { ok: false, error: "no_profile" } } }, { status: 400, body: { code: "21000", message: "m" } });
    await signIn(s2.p); await s2.wired.rpc("register_for_session"); await settle(); await settle();
    expect(s2.reports()).toHaveLength(1);
  });

  it("server verdicts from the real report RPC drive the breaker (disabled => one request, then silence)", async () => {
    const s = setup({ "/rpc/register_for_session": { status: 200, body: { ok: false, error: "no_profile" } }, "/rpc/stop_subscription": { status: 200, body: { ok: false, error: "no_current_version" } } },
      { status: 200, body: { ok: true, accepted: false, reason: "disabled", retry_after_s: null } });
    await signIn(s.p);
    await s.wired.rpc("register_for_session"); await settle();
    await s.wired.rpc("stop_subscription"); await settle();
    expect(s.reports()).toHaveLength(1);
    expect(s.p.getStats().pausedUntil).toBeGreaterThan(0);
  });

  it("an observer / listener / pipeline fault cannot change what the caller gets (results, errors, throwOnError)", async () => {
    const base = async (): Promise<Response> => new Response(JSON.stringify({ code: "21000", message: "m" }), { status: 400, headers: { "content-type": "application/json" } });
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const plain = createClient(URL0, "anon", { ...opts, global: { fetch: base as never } });
    const wired = createClient(URL0, "anon", { ...opts, global: { fetch: base as never } });
    const hostile = { submit: () => { throw new Error("pipeline fault"); } } as unknown as RemoteReportingPipeline;
    const observer = new RpcOutcomeObserver({ isEnabled: () => true, aggregate: () => false });
    observer.configure({ onOutcome: (e) => hostile.submit(candidateFromEvent(e)) });
    installRpcOutcomeObserver(wired, observer);
    expect(pick(await wired.rpc("x"))).toEqual(pick(await plain.rpc("x")));
    let ea: unknown, eb: unknown;
    try { await plain.rpc("x").throwOnError(); } catch (e) { ea = e; }
    try { await wired.rpc("x").throwOnError(); } catch (e) { eb = e; }
    expect((eb as Error).message).toBe((ea as Error).message);
  });

  it("the production observer keeps nothing: no aggregate, no snapshot growth, only the listener runs", () => {
    const events: unknown[] = [];
    const o = new RpcOutcomeObserver({ isEnabled: () => true, aggregate: () => false, onOutcome: (e) => events.push(e) });
    for (let i = 0; i < 500; i++) o.observe(`op_${i % 7}`, { data: { ok: false, error: "no_profile" }, error: null, status: 200 });
    expect(o.getSnapshot().observations).toEqual([]);
    expect(events).toHaveLength(500);
    expect(JSON.stringify(events[0])).toBe(JSON.stringify({ channel: "result", operation: "op_0", code: "no_profile", class: "unknown", raised: false }));
  });

  it("successful results cost the observer only a property read (no classification, no listener call)", () => {
    const events: unknown[] = [];
    const o = new RpcOutcomeObserver({ isEnabled: () => true, aggregate: () => false, onOutcome: (e) => events.push(e) });
    for (let i = 0; i < 20000; i++) o.observe("register_for_session", { data: { ok: true, id: i }, error: null, status: 200 });
    expect(events).toEqual([]);
  });
});

describe("G. static safety", () => {
  it("only delivery.ts names the reporting RPC; no service_role, no console, no stack/arguments/bodies in the sources", () => {
    const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of files) {
      const code = fs.readFileSync(path.join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (f !== "delivery.ts" && f !== "eligibility.ts") expect(code).not.toMatch(/report_client_error/);
      expect(code).not.toMatch(/service_role|console\.|\.stack\b|JSON\.stringify\(\s*(res|result|data|body)/);
    }
  });
});

// H. Confirmed via production browser testing (real Chromium + the real deployed client): a persisted
// session's one-shot auth event can fire before the server flag's first async read resolves. The pipeline
// used to gate onAuth() on enabled(), so that single event was silently dropped and signedIn stayed false
// for the rest of the page's lifetime, even after the flag later became true - no report ever reached
// report_client_error. These tests pin down every resolution order the lifecycle can actually hit.
describe("H. auth/flag ordering (the production race)", () => {
  function mkFlagged(initial: boolean) {
    const flag = { value: initial };
    const sent: WirePayload[] = [];
    const p = new RemoteReportingPipeline({
      enabled: () => flag.value,
      deliver: async (x) => { sent.push(x); return { kind: "server", accepted: true }; },
      schedule: (fn) => fn(),
    });
    return { p, flag, sent };
  }

  it("auth resolves before the flag: signing in while the flag is still false still records signed-in, and a submit after the flag later turns true is delivered", async () => {
    const { p, flag, sent } = mkFlagged(false);
    p.onAuth("SIGNED_IN", true); // the flag has not resolved yet (fail-closed default)
    expect(p.isSignedIn()).toBe(true);
    p.submit(GOOD); // enabled() still false here: nothing queued yet
    await settle();
    expect(sent).toEqual([]);
    flag.value = true; // the flag's async refresh() now resolves true
    p.submit(GOOD); // no further auth event ever fires again for this session - signedIn must already be true
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("the flag resolves before auth: unchanged behavior, still requires signedIn", async () => {
    const { p, sent } = mkFlagged(true);
    p.submit(GOOD); // enabled() true, but not signed in yet
    await settle();
    expect(sent).toEqual([]);
    p.onAuth("INITIAL_SESSION", true);
    p.submit(GOOD);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("both resolve in the same tick: order between onAuth and the flag becoming true does not matter", async () => {
    const a = mkFlagged(false);
    a.p.onAuth("INITIAL_SESSION", true); a.flag.value = true;
    a.p.submit(GOOD); await settle();
    expect(a.sent).toHaveLength(1);

    const b = mkFlagged(false);
    b.flag.value = true; b.p.onAuth("INITIAL_SESSION", true);
    b.p.submit(GOOD); await settle();
    expect(b.sent).toHaveLength(1);
  });

  it("persisted session on cold startup: INITIAL_SESSION arriving before the flag resolves is the exact production scenario and must not be lost", async () => {
    const { p, flag, sent } = mkFlagged(false);
    p.onAuth("INITIAL_SESSION", true);
    expect(p.isSignedIn()).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // simulate the flag's network round trip completing later
    flag.value = true;
    p.submitTransport({ operation: "transport/rpc:get_current_legal_document", errorClass: "HttpError", errorCode: "http_503", context: { http_status: 503 } });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: "transport/infra", error_code: "http_503" });
  });

  it("sign-out then sign-in: signedIn tracks the real auth state regardless of the flag, both transitions", async () => {
    const { p, sent } = mkFlagged(true);
    p.onAuth("SIGNED_IN", true);
    p.submit(GOOD); await settle();
    expect(sent).toHaveLength(1);
    p.onAuth("SIGNED_OUT", false);
    expect(p.isSignedIn()).toBe(false);
    p.submit(candidateFor(SERVER_ALLOWLIST[24]) as OutcomeCandidate); await settle();
    expect(sent).toHaveLength(1); // nothing queued while signed out
    p.onAuth("SIGNED_IN", true);
    expect(p.isSignedIn()).toBe(true);
    p.submit(candidateFor(SERVER_ALLOWLIST[24]) as OutcomeCandidate); await settle();
    expect(sent).toHaveLength(2);
  });

  it("flag refresh after startup: already signed in while the flag is false, then the flag turns true on its own (no new auth event) - delivery starts without needing another sign-in", async () => {
    const { p, flag, sent } = mkFlagged(false);
    p.onAuth("SIGNED_IN", true);
    p.submit(GOOD); await settle();
    expect(sent).toEqual([]);
    flag.value = true; // e.g. the 15-minute periodic refresh, or a later successful retry
    p.submit(GOOD); await settle();
    expect(sent).toHaveLength(1);
  });

  it("startRemoteReporting's real auth listener wiring: an onAuthStateChange callback fired synchronously by the client (before the flag's refresh promise settles) still produces a delivered report once the flag resolves", async () => {
    let authCb: ((event: unknown, session: unknown) => void) | undefined;
    const client = {
      rpc: jest.fn((fn: string) =>
        fn === "system_client_reporting_enabled"
          ? new Promise((resolve) => setTimeout(() => resolve({ data: true, error: null }), 5))
          : Promise.resolve({ data: { ok: true, accepted: true, reason: null, retry_after_s: null }, error: null })
      ),
      auth: { onAuthStateChange: jest.fn((cb: (event: unknown, session: unknown) => void) => { authCb = cb; }) },
    };
    const p = new RemoteReportingPipeline({ enabled: () => false, deliver: null, schedule: (fn) => fn() });
    expect(startRemoteReporting(client, p)).toBe(true);
    authCb?.("INITIAL_SESSION", { user: { id: "u1" } }); // fires before the flag promise above resolves
    expect(p.isSignedIn()).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // let the flag's rpc() resolve
    p.submit(GOOD);
    await settle();
    expect(p.getStats().accepted).toBe(1);
  });
});
