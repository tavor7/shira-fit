import { createClient } from "@supabase/supabase-js";
import { classifyRpcOutcome } from "./classify";
import { installRpcOutcomeObserver, RpcOutcomeObserver } from "./observer";
import { classifyPostgrestError, EXACT_CODE_RULES, CLASS_RULES, ownsHttpStatus, RAISE_TOKEN_RE, REVIEWED_REASON_SHAPES } from "./postgrestErrors";
import { GLOBAL_RULES, OPERATION_RULES } from "./registry";
import { TechnicalReporter, technicalReporter } from "../techReporting/reporter";
import { classifyHttpStatus, withTransportCapture } from "../techReporting/transportCapture";

// Monitoring Phase 3D: structured PostgREST errors (HTTP 4xx), reviewed alternative shapes, partial failures left alone.

const URL0 = "https://proj.supabase.co";
let tick = 1000;
const mk = (over: ConstructorParameters<typeof RpcOutcomeObserver>[0] = {}) => new RpcOutcomeObserver({ now: () => tick++, isEnabled: () => true, ...over });
const err = (status: number, code: unknown, message: unknown = "m") => ({ data: null, error: { code, message, details: "d", hint: "h" }, status, statusText: "" });
const ok = (data: unknown) => ({ data, error: null, status: 200, statusText: "OK" });

describe("A. technical SQLSTATE at HTTP 400 is recognized; expected 400s are not technical", () => {
  it("21000 (safeupdate / cardinality) is technical and future-reportable; the message is not retained", () => {
    const o = mk();
    o.observe("edit_subscription_version", err(400, "21000", "DELETE requires a WHERE clause"));
    const [x] = o.getSnapshot().observations;
    expect(x).toMatchObject({ operation: "edit_subscription_version", channel: "postgrest", code: "21000", class: "technical", source: "structured_code", futureReportable: true, needsReview: false });
    expect(JSON.stringify(o.getSnapshot())).not.toMatch(/WHERE|DELETE requires/);
  });

  it("B. a 400 RAISE of `forbidden` (waitlist_counts) is an expected refusal, never technical", () => {
    const o = mk();
    o.observe("waitlist_counts", err(400, "P0001", "forbidden"));
    expect(o.getSnapshot().observations[0]).toMatchObject({ code: "forbidden", class: "authorization_validation", source: "global", futureReportable: false, needsReview: false });
    expect(o.getSnapshot().totals.technical).toBe(0);
  });

  it("P0001 tokens are classified through the Phase 3A registry (operation first); unregistered tokens stay unknown", () => {
    const o = mk();
    o.observe("register_for_session", err(400, "P0001", "subscription_terms_required"));   // global business rule
    o.observe("update_session_note", err(400, "P0001", "session_not_found"));              // operation-specific: technical
    o.observe("register_for_session", err(400, "P0001", "session_not_found"));             // operation-specific: business
    o.observe("register_for_session", err(400, "P0001", "a_token_nobody_reviewed"));
    const m = Object.fromEntries(o.getSnapshot().observations.map((x) => [`${x.operation}/${x.code}`, [x.class, x.futureReportable, x.needsReview]]));
    expect(m).toEqual({
      "register_for_session/subscription_terms_required": ["business", false, false],
      "update_session_note/session_not_found": ["technical", true, false],
      "register_for_session/session_not_found": ["business", false, false],
      "register_for_session/a_token_nobody_reviewed": ["unknown", false, true],
    });
    for (const x of o.getSnapshot().observations) expect(x.class).toBe(classifyRpcOutcome(x.operation, x.code).class);
  });

  it("P0001 with raw database text / ids / emails is `<non_code>` and unknown; the text is never retained", () => {
    const o = mk();
    for (const msg of ["duplicate key value violates unique constraint \"x\"", "user a@b.com not found", "8a7c2f10-1111-2222-3333-444455556666", "Forbidden", "", 5, null, "x".repeat(500)])
      o.observe("register_for_session", err(400, "P0001", msg));
    o.observe("register_for_session", { data: null, status: 400, error: { code: "P0001" } });   // no message at all
    const s = o.getSnapshot();
    expect(s.observations.map((x) => [x.code, x.class])).toEqual([["<non_code>", "unknown"]]);
    expect(s.observations[0].count).toBe(9);
    expect(JSON.stringify(s)).not.toMatch(/duplicate|a@b\.com|8a7c2f10|xxxxx/);
  });

  it("structured code table: technical / expected / uncertain / unknown, each by code and never by wording", () => {
    const o = mk();
    const table: [number, string, string][] = [
      [400, "21000", "technical"], [400, "42883", "technical"], [400, "42P01", "technical"], [400, "40001", "technical"], [400, "40P01", "technical"],
      [404, "PGRST202", "technical"], [300, "PGRST203", "technical"], [400, "PGRST100", "technical"], [400, "57014", "technical"],
      [401, "PGRST301", "authorization_validation"], [401, "PGRST302", "authorization_validation"],
      [403, "42501", "uncertain"], [406, "PGRST116", "uncertain"], [409, "23505", "uncertain"], [409, "23503", "uncertain"], [400, "23514", "uncertain"], [400, "22P02", "uncertain"],
      [400, "ZZ001", "unknown"], [400, "PGRST999", "unknown"], [400, "P0002", "unknown"], [400, "0A000", "unknown"],
    ];
    for (const [status, code] of table) o.observe("some_rpc", err(status, code, "technical failure fatal error crash"));
    const got = o.getSnapshot().observations.filter((x) => x.code !== "PGRST203").map((x) => [x.code, x.class]);
    expect(got).toEqual(table.filter(([s, c]) => c !== "PGRST203").map(([, c, k]) => [c, k]));
    // PGRST203 was sent with status 300: not an error status we own
    expect(o.getSnapshot().observations.some((x) => x.code === "PGRST203")).toBe(false);
    for (const x of o.getSnapshot().observations) expect(x.futureReportable).toBe(x.class === "technical");
  });

  it("unknown stays unknown: never reportable, needs review; codes of the wrong shape are placeholders", () => {
    const o = mk();
    o.observe("r", err(400, "ZZ001"));
    o.observe("r", err(400, "not a code"));
    o.observe("r", err(400, "pgrst202"));       // case-sensitive
    o.observe("r", err(400, undefined));
    o.observe("r", err(400, ""));
    o.observe("r", err(400, { nested: 1 }));
    const s = o.getSnapshot();
    expect(s.observations.map((x) => [x.code, x.class, x.futureReportable, x.needsReview])).toEqual([
      ["ZZ001", "unknown", false, true], ["<non_code>", "unknown", false, true], ["<no_code>", "unknown", false, true],
    ]);
    expect(s.totals.malformed).toBe(3);
  });

  it("every exact/class rule has a class, a rationale and a well-formed key", () => {
    for (const [k, [c, why]] of Object.entries(EXACT_CODE_RULES)) {
      expect(/^[0-9A-Z]{5}$/.test(k) || /^PGRST[0-9]{3}$/.test(k)).toBe(true);
      expect(["technical", "authorization_validation", "uncertain", "business"]).toContain(c);
      expect(why.length).toBeGreaterThan(10);
    }
    for (const [k, [c, why]] of Object.entries(CLASS_RULES)) { expect(k).toHaveLength(2); expect(c).toBeTruthy(); expect(why.length).toBeGreaterThan(10); }
    // P0001 is never decided by the table: only by the registry
    expect(Object.keys(EXACT_CODE_RULES)).not.toContain("P0001");
  });

  it("every registered code is a valid RAISE token shape (otherwise a P0001 raise of it could never be classified)", () => {
    const codes = new Set<string>(Object.keys(GLOBAL_RULES));
    for (const rules of Object.values(OPERATION_RULES)) for (const c of Object.keys(rules)) codes.add(c);
    expect([...codes].filter((c) => !RAISE_TOKEN_RE.test(c))).toEqual([]);
  });
});

describe("C. ownership: exactly one layer sees a failure (no double counting)", () => {
  it("5xx, 408, 429, network failure (status 0), 2xx-with-error and missing status are Phase 3B's; the observer only counts them", () => {
    const o = mk();
    for (const status of [500, 502, 503, 504, 520, 408, 429, 0, 200, 204, 302])  o.observe("r", err(status, "21000"));
    o.observe("r", { data: null, error: { code: "21000", message: "m" } });                         // no status
    o.observe("r", { data: null, error: { code: "21000", message: "m" }, status: "400" });         // wrong type
    o.observe("r", { data: null, error: { code: "21000", message: "m" }, status: 400.5 });
    expect(o.getSnapshot().observations).toEqual([]);
    expect(o.getSnapshot().transportOwned).toBe(11 + 3);
    expect(o.getSnapshot().totals).toMatchObject({ technical: 0, unknown: 0, malformed: 0 });
  });

  it("for every HTTP status the transport layer and the RPC observer never both own an RPC error", () => {
    for (let status = 0; status <= 599; status++) {
      const transport = classifyHttpStatus("rpc", status).report;
      const observer = ownsHttpStatus(status);
      expect(transport && observer).toBe(false);
      if (status >= 500 || status === 408 || status === 429) expect(transport).toBe(true);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) expect(observer).toBe(true);
      if (status < 400) expect(observer).toBe(false);
    }
  });

  it("real supabase-js client: 503 with a technical code is one transport report and no observation; 400 is one observation and no transport report", async () => {
    const transport = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}), maxReportsPerWindow: 1000 });
    const responses: Record<string, { status: number; body: unknown }> = {
      "/rpc/svc": { status: 503, body: { code: "21000", message: "m" } },
      "/rpc/bad": { status: 400, body: { code: "21000", message: "DELETE requires a WHERE clause" } },
      "/rpc/forbid": { status: 400, body: { code: "P0001", message: "forbidden" } },
    };
    const base = async (input: RequestInfo | URL): Promise<Response> => {
      const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
      const k = Object.keys(responses).find((x) => u.includes(x))!;
      return new Response(JSON.stringify(responses[k].body), { status: responses[k].status, headers: { "content-type": "application/json" } });
    };
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const mkc = (observe: boolean) => {
      const o = mk();
      const c = createClient(URL0, "anon", { ...opts, global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: (r) => transport.report(r) }) as never } });
      if (observe) installRpcOutcomeObserver(c, o);
      return { c, o };
    };
    const { c, o } = mkc(true);
    const plain = mkc(false).c;
    transport.reset();
    for (const fn of ["svc", "bad", "forbid"]) {
      const a = await plain.rpc(fn);
      const b = await c.rpc(fn);
      expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));    // identical result, with and without the observer
    }
    const s = o.getSnapshot();
    expect(s.observations.map((x) => [x.operation, x.code, x.class])).toEqual([["bad", "21000", "technical"], ["forbid", "forbidden", "authorization_validation"]]);
    expect(s.transportOwned).toBe(1);        // the 503 `svc` call on the observed client
    // both clients' `svc` calls reach the transport reporter (coalesced into one entry); `bad`/`forbid` (4xx) never do
    expect(transport.getObserved().map((x) => x.report.context?.rpc)).toEqual(["svc"]);
  });
});

describe("D. reviewed alternative outcome shapes", () => {
  it("manager_activity_revert_info `reason` is observed only for ok:true + can_revert:false, classified through the registry", () => {
    const o = mk();
    o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: "already_reverted" }));
    o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: "missing_registration_context" }));
    o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: "a_reason_nobody_reviewed" }));
    o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: true }));
    o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: true, reason: "already_reverted" }));   // reason alongside success: not an outcome
    o.observe("manager_activity_revert_info", ok({ ok: false, error: "forbidden" }));                              // normal channel
    const m = o.getSnapshot().observations.map((x) => [x.channel, x.code, x.class]);
    expect(m).toEqual([
      ["reason", "already_reverted", classifyRpcOutcome("manager_activity_revert_info", "already_reverted").class],
      ["reason", "missing_registration_context", "technical"],
      ["reason", "a_reason_nobody_reviewed", "unknown"],
      ["result", "forbidden", "authorization_validation"],
    ]);
    expect(o.getSnapshot().observations[1]).toMatchObject({ futureReportable: true });
    expect(o.getSnapshot().observations[2]).toMatchObject({ futureReportable: false, needsReview: true });
  });

  it("every reason registered for the operation is observed with exactly its registry class (none is unknown)", () => {
    const rules = OPERATION_RULES.manager_activity_revert_info;
    const o = mk();
    for (const code of Object.keys(rules)) o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: code }));
    const s = o.getSnapshot();
    expect(s.observations.length).toBe(Object.keys(rules).length);
    for (const x of s.observations) { expect(x.class).not.toBe("unknown"); expect(x.class).toBe(classifyRpcOutcome(x.operation, x.code).class); }
  });

  it("a `reason`, `status`, `success` or failure-count field on any OTHER operation is never an outcome (no field-name heuristics)", () => {
    const o = mk();
    const bodies: unknown[] = [
      { ok: true, can_revert: false, reason: "already_reverted" },     // the reviewed shape, but on another operation
      { ok: true, reason: "x" }, { reason: "x" }, { ok: true, status: "failed" }, { success: false }, { success: false, error: "full" },
      { ok: true, failed: 3 }, { ok: true, failed_count: 2, failed: [{ id: 1, error: "x" }] }, { ok: true, errors: ["a"] }, { ok: true, error: "full" },
    ];
    for (const b of bodies) o.observe("register_for_session", ok(b));
    expect(o.getSnapshot().observations).toEqual([]);
    expect(o.getSnapshot().totals).toMatchObject({ business: 0, technical: 0, unknown: 0, uncertain: 0, authorization_validation: 0, malformed: 0 });
  });

  it("the table of reviewed shapes is exactly the one reviewed operation", () => {
    expect(Object.keys(REVIEWED_REASON_SHAPES)).toEqual(["manager_activity_revert_info"]);
  });
});

describe("E. partial failures are NOT classified here", () => {
  it("create_documents_from_payments / maintain_session_series_horizon / push helpers with failed counts produce no observation", () => {
    const o = mk();
    o.observe("create_documents_from_payments", ok({ ok: true, created_count: 3, failed_count: 2, failed: [{ row_id: "r", error: "digital_receipts_disabled" }] }));
    o.observe("create_documents_from_payments", ok({ ok: true, created_count: 0, failed_count: 5, failed: [{ error: "unexpected_boom" }] }));
    o.observe("maintain_session_series_horizon", ok({ ok: true, created: 0, reconciled: 0, failed: 4, unresolved_ownership: 1 }));
    o.observe("send_custom_push_notification", ok({ ok: true, notified: 0, skipped_no_marketing_consent: 7 }));
    o.observe("notify_session_participants_updated", ok({ ok: true, notified: 0 }));
    expect(o.getSnapshot().observations).toEqual([]);
    expect(o.getSnapshot().totals).toMatchObject({ technical: 0, unknown: 0, malformed: 0 });
  });
});

describe("F. semantic transparency, privacy and bounds", () => {
  it("error results, rejections and exceptions reach the caller unchanged; an observer fault cannot change them", async () => {
    const base = async (): Promise<Response> => new Response(JSON.stringify({ code: "21000", message: "DELETE requires a WHERE clause", details: "secret detail", hint: "secret hint" }), { status: 400, headers: { "content-type": "application/json" } });
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const plain = createClient(URL0, "anon", { ...opts, global: { fetch: base as never } });
    const wrapped = createClient(URL0, "anon", { ...opts, global: { fetch: base as never } });
    const hostile = mk({ isEnabled: () => { throw new Error("observer fault"); } });
    installRpcOutcomeObserver(wrapped, hostile);
    const a = await plain.rpc("edit_subscription_version");
    const b = await wrapped.rpc("edit_subscription_version");
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    expect(b.error?.message).toBe("DELETE requires a WHERE clause");                         // business/technical text still reaches the UI
    // throwOnError: the very same error is thrown with and without the observer
    let ea: unknown; let eb: unknown;
    try { await plain.rpc("x").throwOnError(); } catch (e) { ea = e; }
    try { await wrapped.rpc("x").throwOnError(); } catch (e) { eb = e; }
    expect((eb as Error).message).toBe((ea as Error).message);
    expect(hostile.getSnapshot().observations).toEqual([]);
  });

  it("an error object with hostile getters or exotic shapes never throws and is never mutated", () => {
    const o = mk();
    const frozen = Object.freeze({ data: null, status: 400, error: Object.freeze({ code: "21000", message: "m", details: Object.freeze({ a: 1 }) }) });
    const before = JSON.stringify(frozen);
    expect(() => o.observe("r", frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
    for (const bad of [{ status: 400, error: { get code(): unknown { throw new Error("x"); } } }, { status: 400, error: new Proxy({}, { get() { throw new Error("p"); } }) }, { status: 400, error: "string error" }, { status: 400, error: 5 }, { status: 400, error: [] }])
      expect(() => o.observe("r", bad)).not.toThrow();
  });

  it("nothing sensitive is retained: only allowlisted operation names and code-shaped strings", () => {
    const o = mk();
    const secret = "alice@example.com 0501234567 8a7c2f10-1111-2222-3333-444455556666";
    o.observe("register_for_session", { data: null, status: 400, error: { code: "P0001", message: secret, details: secret, hint: secret } });
    o.observe("r p c; drop", { data: null, status: 400, error: { code: "21000", message: secret, details: secret, hint: secret } });
    o.observe("register_for_session", { data: null, status: 409, error: { code: secret, message: secret } });
    const json = JSON.stringify(o.getSnapshot());
    expect(json).not.toMatch(/alice|example|0501234567|8a7c2f10|drop/);
    expect(o.getSnapshot().observations.map((x) => [x.operation, x.code])).toEqual([["register_for_session", "<non_code>"], ["<other_operation>", "21000"]]);
  });

  it("memory stays bounded under a flood of distinct failures across all channels", () => {
    const o = mk({ maxKeys: 50 });
    for (let i = 0; i < 2000; i++) {
      o.observe(`op_${i}`, err(400, "21000"));
      o.observe(`op_${i}`, err(400, "P0001", `token_${i}`));
      o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: `reason_${i}` }));
    }
    const s = o.getSnapshot();
    expect(s.observations.length).toBeLessThanOrEqual(50);
    expect(s.overflow).toBeGreaterThan(5000);
    expect(s.inspected).toBe(6000);
  });

  it("classifyPostgrestError is pure and total", () => {
    for (const e of [undefined, null, 5, "s", {}, [], { code: 5 }, { code: "P0001" }, { code: "P0001", message: { x: 1 } }]) expect(() => classifyPostgrestError("op", e)).not.toThrow();
    expect(classifyPostgrestError("op", { code: "21000", message: "m" })).toMatchObject({ class: "technical", raised: false, source: "structured_code" });
    expect(classifyPostgrestError("op", { code: "P0001", message: "forbidden" })).toMatchObject({ class: "authorization_validation", raised: true });
  });

  it("no remote reporting: observing every channel touches neither the Phase 3B reporter nor any delivery", () => {
    technicalReporter.reset();
    const o = mk();
    for (let i = 0; i < 50; i++) {
      o.observe("edit_subscription_version", err(400, "21000"));
      o.observe("register_for_session", ok({ ok: false, error: "no_profile" }));
      o.observe("manager_activity_revert_info", ok({ ok: true, can_revert: false, reason: "missing_registration_context" }));
    }
    expect(technicalReporter.getObserved()).toEqual([]);
    expect(technicalReporter.getStats()).toEqual({ accepted: 0, coalesced: 0, droppedByCap: 0, invalid: 0 });
  });
});
