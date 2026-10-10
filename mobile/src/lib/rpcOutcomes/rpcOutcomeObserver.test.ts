/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { classifyRpcOutcome } from "./classify";
import { installRpcOutcomeObserver, RpcOutcomeObserver } from "./observer";
import { TechnicalReporter, technicalReporter } from "../techReporting/reporter";
import { withTransportCapture } from "../techReporting/transportCapture";

const URL0 = "https://proj.supabase.co";

function obs(over: ConstructorParameters<typeof RpcOutcomeObserver>[0] = {}) {
  let t = 1000;
  return { o: new RpcOutcomeObserver({ now: () => t++, isEnabled: () => true, ...over }) };
}
const ok = (data: unknown) => ({ data, error: null, status: 200, statusText: "OK" });

describe("observation: classification of application-level outcomes (HTTP success, ok:false)", () => {
  it("A. a normal successful RPC is not an outcome", () => {
    const { o } = obs();
    for (const data of [{ ok: true }, { ok: true, late_cancellation: true }, [{ id: 1 }], "text", 5, null, undefined, true, { ok: "false" }, { ok: 0 }, {}]) o.observe("register_for_session", ok(data));
    expect(o.getSnapshot().observations).toEqual([]);
    expect(o.getSnapshot().totals).toMatchObject({ business: 0, technical: 0, unknown: 0, uncertain: 0, authorization_validation: 0, malformed: 0 });
  });

  it("B. BUSINESS ok:false is classified business and is not future-reportable", () => {
    const { o } = obs();
    o.observe("register_for_session", ok({ ok: false, error: "full" }));
    expect(o.getSnapshot().observations[0]).toMatchObject({ operation: "register_for_session", code: "full", class: "business", futureReportable: false, needsReview: false, count: 1 });
  });

  it("C. AUTHORIZATION_VALIDATION is classified and is not future-reportable", () => {
    const { o } = obs();
    o.observe("staff_set_account_disabled", ok({ ok: false, error: "forbidden" }));
    o.observe("create_subscription", ok({ ok: false, error: "invalid_price" }));
    const s = o.getSnapshot();
    expect(s.observations.map((x) => [x.code, x.class, x.futureReportable])).toEqual([["forbidden", "authorization_validation", false], ["invalid_price", "authorization_validation", false]]);
  });

  it("D. TECHNICAL is classified and marked future-reportable (observed locally only)", () => {
    const { o } = obs();
    o.observe("register_for_session", ok({ ok: false, error: "no_profile" }));
    o.observe("freeze_subscription", ok({ ok: false, error: "no_current_version" }));
    expect(o.getSnapshot().observations.map((x) => [x.class, x.futureReportable, x.needsReview])).toEqual([["technical", true, false], ["technical", true, false]]);
  });

  it("E. UNCERTAIN stays uncertain, needs review, is not future-reportable", () => {
    const { o } = obs();
    for (const [op, code] of [["cancel_registration", "update_failed"], ["set_registration_attendance", "update_failed"], ["set_manual_participant_attendance", "update_failed"], ["edit_subscription_version", "concurrent_modification"], ["_try_sync_signup_consent_for_user", "user_not_found"]]) {
      o.observe(op, ok({ ok: false, error: code }));
    }
    const s = o.getSnapshot();
    expect(s.observations).toHaveLength(5);
    expect(s.observations.every((x) => x.class === "uncertain" && x.needsReview && !x.futureReportable)).toBe(true);
  });

  it("F. UNKNOWN (unregistered pair) stays unknown and visible; names never decide the class", () => {
    const { o } = obs();
    o.observe("brand_new_rpc", ok({ ok: false, error: "full" }));                  // known string, unregistered operation
    o.observe("register_for_session", ok({ ok: false, error: "totally_new_failed_error" })); // looks like a failure: still unknown
    o.observe("register_for_session", ok({ ok: false, error: "not_something" }));
    o.observe("register_for_session", ok({ ok: false, error: "invalid_thing" }));
    const s = o.getSnapshot();
    expect(s.observations).toHaveLength(4);
    expect(s.observations.every((x) => x.class === "unknown" && x.needsReview && !x.futureReportable)).toBe(true);
    expect(s.totals.unknown).toBe(4);
  });

  it("G. the same code in different operations keeps its operation-specific class", () => {
    const { o } = obs();
    o.observe("update_session_note", ok({ ok: false, error: "session_not_found" }));
    o.observe("register_for_session", ok({ ok: false, error: "session_not_found" }));
    const m = Object.fromEntries(o.getSnapshot().observations.map((x) => [x.operation, x.class]));
    expect(m).toEqual({ update_session_note: "technical", register_for_session: "business" });
  });

  it("classification equals the Phase 3A registry for every observation", () => {
    const { o } = obs();
    const pairs: [string, string][] = [["coach_add_athlete", "subscription_limit_exceeded"], ["stop_subscription", "freeze_overlap"], ["manager_revert_activity_event", "session_full"], ["x_op", "y_code"]];
    for (const [op, code] of pairs) o.observe(op, ok({ ok: false, error: code }));
    for (const x of o.getSnapshot().observations) expect(x.class).toBe(classifyRpcOutcome(x.operation, x.code).class);
  });

  it("aggregates repeated outcomes (count, first/last) under one key", () => {
    const { o } = obs();
    for (let i = 0; i < 5; i++) o.observe("register_for_session", ok({ ok: false, error: "full" }));
    const [x] = o.getSnapshot().observations;
    expect(x.count).toBe(5);
    expect(x.lastAt).toBeGreaterThan(x.firstAt);
  });
});

describe("observation: robustness and ownership boundary", () => {
  it("H/I. malformed or unexpected results never throw and are never mutated", () => {
    const { o } = obs();
    const results: unknown[] = [undefined, null, 0, "s", [], [{ ok: false, error: "full" }], { data: undefined }, { data: { ok: false } }, { data: { ok: false, error: 5 } },
      { data: { ok: false, error: { nested: "x" } } }, { data: Object.create(null) }, { get data(): unknown { throw new Error("hostile"); } }, new Proxy({}, { get() { throw new Error("proxy"); } }), Symbol("x")];
    for (const r of results) expect(() => o.observe("op", r)).not.toThrow();
    expect(() => o.observe(Symbol("op") as never, ok({ ok: false, error: "x" }))).not.toThrow();
    const frozen = Object.freeze({ data: Object.freeze({ ok: false, error: "full", extra: Object.freeze({ a: 1 }) }), error: null });
    const before = JSON.stringify(frozen);
    expect(() => o.observe("register_for_session", frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
    expect(o.getSnapshot().totals.malformed).toBeGreaterThan(0);                  // ok:false with no usable code is visible
    expect(o.getSnapshot().observations.some((x) => x.code === "<no_code>")).toBe(true);
  });

  it("J/K. a result carrying an error (Phase 3B territory) is not observed as an application outcome", () => {
    const { o } = obs();
    o.observe("register_for_session", { data: { ok: false, error: "full" }, error: { message: "boom", code: "PGRST000" }, status: 503 });
    o.observe("register_for_session", { data: null, error: { message: "upstream", code: "PGRST000" }, status: 503 });
    expect(o.getSnapshot().observations).toEqual([]);
  });

  it("disabled observer does nothing at all", () => {
    const { o } = obs({ isEnabled: () => false });
    o.observe("register_for_session", ok({ ok: false, error: "full" }));
    expect(o.getSnapshot()).toMatchObject({ observations: [], inspected: 0 });
  });

  it("M. large results cost O(1): no iteration, stringify or clone", () => {
    const { o } = obs();
    const big = { ok: true, rows: new Array(2_000_000).fill({ a: "x".repeat(50) }) };
    const hugeText = "a".repeat(5_000_000);
    const arr = new Array(100_000).fill(1);
    const rBig = ok(big), rArr = ok(arr), rText = ok({ ok: false, error: hugeText });      // built OUTSIDE the timed loop
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) {
      o.observe("op_big", rBig);
      o.observe("op_big", rArr);
      o.observe("op_big", rText);
    }
    expect(Date.now() - t0).toBeLessThan(500);
    expect(JSON.stringify(o.getSnapshot()).length).toBeLessThan(2000);
  });

  it("N. flood of distinct operation/code pairs is bounded", () => {
    const { o } = obs({ maxKeys: 50 });
    for (let i = 0; i < 20_000; i++) o.observe(`op_${i % 7}`, ok({ ok: false, error: `code_${i}` }));
    const s = o.getSnapshot();
    expect(s.observations.length).toBeLessThanOrEqual(50);
    expect(s.overflow).toBeGreaterThan(19_000);
    expect(s.inspected).toBe(20_000);
  });

  it("O. nothing sensitive is retained: only an allowlisted operation and a code-shaped string", () => {
    const { o } = obs();
    const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlMTIz";
    o.observe("register_for_session", ok({ ok: false, error: "full", user_id: "123e4567-e89b-12d3-a456-426614174000", email: "a@b.com", phone: "0501234567", token: secret, session_id: "s1" }));
    o.observe("register_for_session", ok({ ok: false, error: `duplicate key value violates unique constraint "x" Key (email)=(a@b.com) ${secret}` }));
    o.observe("coach_add_athlete", ok({ ok: false, error: 'insert or update on table "profiles" violates foreign key (user 123e4567-e89b-12d3-a456-426614174000)' }));
    o.observe("rpc with spaces & token " + secret, ok({ ok: false, error: "full" }));
    const text = JSON.stringify(o.getSnapshot());
    expect(text).not.toMatch(/123e4567|a@b\.com|0501234567|eyJ|duplicate key|violates|foreign key|spaces|token|user_id|email|phone|session_id/i);
    expect(o.getSnapshot().observations.map((x) => `${x.operation}|${x.code}`).sort()).toEqual(
      ["<other_operation>|full", "coach_add_athlete|<non_code>", "register_for_session|<non_code>", "register_for_session|full"].sort()
    );
    // raw database text is flagged as possible for operations that can produce it, but is never stored
    expect(o.getSnapshot().observations.find((x) => x.operation === "coach_add_athlete")).toMatchObject({ dynamicErrorPossible: true, class: "unknown" });
  });
});

// ---- integration with the REAL supabase-js client ----
type Scripted = { status: number; body: unknown } | "network";
function scripted(responses: Record<string, Scripted>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
    const key = Object.keys(responses).find((k) => u.includes(k));
    const r = key ? responses[key] : { status: 200, body: [] };
    if (r === "network") throw new TypeError("Network request failed");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}
function makeClients(responses: Record<string, Scripted>) {
  const base = scripted(responses);
  const transport = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}), maxReportsPerWindow: 1000 });
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const plain = createClient(URL0, "anon", { ...opts, global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: () => undefined }) as never } });
  const wrapped = createClient(URL0, "anon", { ...opts, global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: (r) => transport.report(r) }) as never } });
  const { o } = obs();
  installRpcOutcomeObserver(wrapped, o);
  return { plain, wrapped, o, transport };
}
const pick = (r: unknown) => {
  const x = r as { data: unknown; error: { message?: string; code?: string; hint?: string } | null; status: number; statusText: string; count: unknown };
  return JSON.parse(JSON.stringify({ data: x.data, status: x.status, statusText: x.statusText, count: x.count, error: x.error ? { message: x.error.message, code: x.error.code, hint: x.error.hint } : null }));
};

describe("the real supabase-js client: identical results, correct ownership", () => {
  it("success, business, technical, unknown outcomes: identical results to the un-observed client; observation as classified", async () => {
    const cases: [string, unknown][] = [
      ["register_for_session", { ok: true }],
      ["register_for_session", { ok: false, error: "full" }],
      ["register_for_session", { ok: false, error: "no_profile" }],
      ["register_for_session", { ok: false, error: "a_code_nobody_classified" }],
      ["list_session_participants", [{ id: 1 }]],
    ];
    for (const [fn, body] of cases) {
      const { plain, wrapped, o, transport } = makeClients({ [`/rpc/${fn}`]: { status: 200, body } });
      const a = await plain.rpc(fn, { p_session_id: "s" });
      const b = await wrapped.rpc(fn, { p_session_id: "s" });
      expect(pick(b)).toEqual(pick(a));
      expect(transport.getObserved()).toEqual([]);      // transport layer reports nothing for HTTP 200
      const seen = o.getSnapshot().observations;
      if ((body as { ok?: boolean }).ok === false) expect(seen).toHaveLength(1);
      else expect(seen).toEqual([]);
    }
  });

  it("K. HTTP 503 / network failure: transport layer owns it (one report); the outcome observer sees nothing", async () => {
    const r503 = makeClients({ "/rpc/f": { status: 503, body: { message: "down", code: "PGRST000" } } });
    const a = await r503.plain.rpc("f");
    const b = await r503.wrapped.rpc("f");
    expect(pick(b)).toEqual(pick(a));
    expect(r503.transport.getObserved()).toHaveLength(1);
    expect(r503.o.getSnapshot().observations).toEqual([]);
    const net = makeClients({ "/rpc/g": "network" });
    const nb = await net.wrapped.rpc("g");
    expect(nb.error).not.toBeNull();
    expect(net.transport.getObserved()).toHaveLength(1);
    expect(net.o.getSnapshot().observations).toEqual([]);
  });

  it("HTTP 400 (RAISE token) is a PostgREST error result: not observed here, not reported by transport", async () => {
    const c = makeClients({ "/rpc/h": { status: 400, body: { code: "P0001", message: "account_disabled_payee" } } });
    const b = await c.wrapped.rpc("h");
    expect(b.error?.message).toBe("account_disabled_payee");
    expect(c.o.getSnapshot().observations).toEqual([]);
    expect(c.transport.getObserved()).toEqual([]);
  });

  it("chain modifiers, Promise.all, .then chains and throwOnError keep their semantics", async () => {
    const c = makeClients({ "/rpc/one": { status: 200, body: { ok: false, error: "full" } }, "/rpc/two": { status: 503, body: { message: "x" } } });
    const s = await c.wrapped.rpc("one").single();
    expect((s.data as { error?: string }).error).toBe("full");
    const [x, y] = await Promise.all([c.wrapped.rpc("one"), c.wrapped.rpc("one", {}, { get: true })]);
    expect(x.data).toEqual(y.data);
    const viaThen = await c.wrapped.rpc("one").then((r) => ({ wrapped: r.data }));
    expect(viaThen).toEqual({ wrapped: { ok: false, error: "full" } });
    await expect(c.wrapped.rpc("two").throwOnError()).rejects.toBeTruthy();      // rejection path is untouched
    const ctl = new AbortController(); ctl.abort();
    const aborted = await c.wrapped.rpc("one").abortSignal(ctl.signal);
    expect(aborted.error).not.toBeNull(); // cancellation surfaces exactly as without the observer
    expect(c.o.getSnapshot().observations.filter((q) => q.code === "full")).toHaveLength(1);
    expect(c.o.getSnapshot().observations[0].count).toBe(4); // single + 2x Promise.all + then; the 503 (throwOnError) and the aborted call are not outcomes
  });

  it("an observer that throws internally cannot change the result (L)", async () => {
    const base = scripted({ "/rpc/p": { status: 200, body: { ok: false, error: "full" } } });
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const client = createClient(URL0, "anon", { ...opts, global: { fetch: base as never } });
    const evil = { observe() { throw new Error("observer bug"); } } as unknown as RpcOutcomeObserver;
    installRpcOutcomeObserver(client, evil);
    const r = await client.rpc("p");
    expect(r.data).toEqual({ ok: false, error: "full" });
    expect(r.error).toBeNull();
  });

  it("microtask ordering of the result delivery is unchanged", async () => {
    const order = async (install: boolean) => {
      const seq: string[] = [];
      const builder = { then(onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) { return Promise.resolve({ data: { ok: false, error: "full" }, error: null }).then(onf, onr); } };
      const client = { rpc: () => builder };
      if (install) installRpcOutcomeObserver(client, obs().o);
      Promise.resolve().then(() => seq.push("m1")).then(() => seq.push("m2")).then(() => seq.push("m3")).then(() => seq.push("m4"));
      await (client.rpc() as PromiseLike<unknown>).then(() => seq.push("result"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      return seq;
    };
    expect(await order(true)).toEqual(await order(false));
  });

  it("installing twice is a no-op; a client without rpc is ignored", () => {
    const client = { rpc: () => ({ then() { return undefined; } }) };
    expect(installRpcOutcomeObserver(client, obs().o)).toBe(true);
    expect(installRpcOutcomeObserver(client, obs().o)).toBe(false);
    expect(installRpcOutcomeObserver({}, obs().o)).toBe(false);
    expect(installRpcOutcomeObserver(null, obs().o)).toBe(false);
  });
});

describe("P. Phase 3C can never report remotely or create monitoring rows", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("the observer module imports neither the technical reporter nor any delivery code, and has no network or RPC calls", () => {
    const src = read("src/lib/rpcOutcomes/observer.ts");
    expect(src).not.toMatch(/techReporting|reportTechnicalError|setDeliverer|report_client_error|system_report_trusted|fetch\(|\.rpc\(["']/);
    const imports = [...src.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./classify", "./types"]);
  });

  it("no application code calls the ingestion RPC or installs a delivery hook; ingestion stays configured off in the repo", () => {
    const offenders: string[] = [];
    for (const f of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "app"))]) {
      const t = fs.readFileSync(f, "utf8");
      if (/\.rpc\(\s*["'](report_client_error|system_report_trusted)["']/.test(t)) offenders.push(`${f}: ingestion rpc`);
      if (/\.setDeliverer\(/.test(t) && !/techReporting\/reporter\.ts$/.test(f)) offenders.push(`${f}: setDeliverer`);
      if (/client_ingest_enabled/.test(t) && !/rpcOutcomes|techReporting/.test(f)) offenders.push(`${f}: client_ingest_enabled`);
    }
    expect(offenders).toEqual([]);
  });

  it("the observer is installed only in development builds", () => {
    const src = read("src/lib/supabase.ts");
    expect(src).toMatch(/if \(typeof __DEV__ !== "undefined" && __DEV__\) \{\s*installRpcOutcomeObserver\(supabase\);\s*\}/);
    expect((src.match(/installRpcOutcomeObserver\(/g) ?? []).length).toBe(1);
  });

  it("observing technical outcomes touches neither the Phase 3B reporter nor any delivery", () => {
    technicalReporter.reset();
    const { o } = obs();
    for (let i = 0; i < 50; i++) o.observe("register_for_session", ok({ ok: false, error: "no_profile" }));
    expect(technicalReporter.getObserved()).toEqual([]);
    expect(technicalReporter.getStats()).toEqual({ accepted: 0, coalesced: 0, droppedByCap: 0, invalid: 0 });
  });
});
