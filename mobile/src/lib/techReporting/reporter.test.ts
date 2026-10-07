import { TechnicalReporter, reportTechnicalError, technicalReporter, toWirePayload } from "./reporter";
import { sanitizeContext, sanitizeMessage, sanitizeOperation } from "./sanitize";

function make(over: ConstructorParameters<typeof TechnicalReporter>[0] = {}) {
  let t = 1_000_000;
  const r = new TechnicalReporter({ now: () => t, isDev: () => true, buildInfo: () => ({ platform: "ios", env: "dev", appVersion: "1.0.0" }), ...over });
  return { r, advance: (ms: number) => (t += ms), clock: () => t };
}

describe("reporter: never throws and normalizes anything", () => {
  it("accepts a normal technical error", () => {
    const { r } = make();
    r.report({ operation: "transport/rpc:register_for_session", error: new TypeError("Network request failed"), severity: "warning", context: { http_status: 503, rpc: "register_for_session" } });
    const [o] = r.getObserved();
    expect(o.report).toMatchObject({
      operation: "transport/rpc:register_for_session",
      errorClass: "TypeError",
      message: "Network request failed",
      severity: "warning",
      platform: "ios",
      appVersion: "1.0.0",
      context: { http_status: 503, rpc: "register_for_session" },
    });
    expect(o.count).toBe(1);
  });

  it.each([undefined, null, 0, "str", 42, {}, [], Symbol("s"), () => 1, new Date(), Object.create(null), { message: 12 }])(
    "does not crash on unexpected input %#",
    (bad) => {
      const { r } = make();
      expect(() => r.report(bad as never)).not.toThrow();
      expect(() => r.report({ error: bad } as never)).not.toThrow();
      expect(() => reportTechnicalError({ error: bad } as never)).not.toThrow();
    }
  );

  it("does not crash on hostile objects (throwing getters, cycles, huge strings)", () => {
    const { r } = make();
    const hostile = {
      get name(): string { throw new Error("boom"); },
      get code(): string { throw new Error("boom"); },
      get message(): string { throw new Error("boom"); },
    };
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => r.report({ error: hostile })).not.toThrow();
    expect(() => r.report({ error: cyc, context: cyc })).not.toThrow();
    expect(() => r.report({ message: "x".repeat(1_000_000) })).not.toThrow();
    expect(r.getObserved().every((o) => o.report.message.length <= 200)).toBe(true);
  });

  it("a failing deliverer (sync throw or async rejection) never affects the caller and is never reported itself", async () => {
    const { r } = make();
    r.setDeliverer(() => { throw new Error("endpoint down"); });
    expect(() => r.report({ message: "a" })).not.toThrow();
    r.setDeliverer(() => Promise.reject(new Error("offline")));
    expect(() => r.report({ message: "b" })).not.toThrow();
    await Promise.resolve();
    expect(r.getObserved().map((o) => o.report.message)).toEqual(["a", "b"]); // delivery errors produced no extra reports
  });

  it("a report triggered from inside delivery is dropped (re-entrancy guard)", () => {
    const { r } = make();
    r.setDeliverer(() => r.report({ message: "from inside delivery" }));
    r.report({ message: "outer" });
    expect(r.getObserved().map((o) => o.report.message)).toEqual(["outer"]);
  });

  it("delivers the wire payload only when a deliverer is installed (none in Phase 3B)", () => {
    const { r } = make();
    r.report({ message: "nothing delivers", errorCode: "x_1" });
    const got: unknown[] = [];
    r.setDeliverer((p) => { got.push(p); });
    r.report({ message: "now delivered", errorCode: "x_2", context: { http_status: 500 } });
    expect(got).toEqual([
      { operation: "transport/unspecified", error_class: "Error", error_code: "x_2", message: "now delivered", severity: "error", context: { http_status: 500 }, app_version: "1.0.0", platform: "ios", env: "dev" },
    ]);
  });
});

describe("reporter: bounds and duplicate suppression", () => {
  it("observation buffer is bounded", () => {
    const { r } = make({ maxObserved: 5, maxReportsPerWindow: 1000 });
    for (let i = 0; i < 40; i++) r.report({ message: `distinct failure kind ${"a".repeat(i)}` });
    expect(r.getObserved()).toHaveLength(5);
  });

  it("identical reports inside the window are coalesced; after the window they count again", () => {
    const { r, advance } = make();
    for (let i = 0; i < 25; i++) r.report({ operation: "transport/rpc:x", message: "HTTP 503", errorCode: "http_503", context: { http_status: 503 } });
    expect(r.getObserved()).toHaveLength(1);
    expect(r.getObserved()[0].count).toBe(25);
    expect(r.getStats()).toMatchObject({ accepted: 1, coalesced: 24 });
    advance(61_000);
    r.report({ operation: "transport/rpc:x", message: "HTTP 503", errorCode: "http_503", context: { http_status: 503 } });
    expect(r.getObserved()).toHaveLength(2);
  });

  it("a global cap per window drops the excess (no retry storm)", () => {
    const { r } = make({ maxReportsPerWindow: 10 });
    for (let i = 0; i < 100; i++) r.report({ message: `kind ${i} ${"z".repeat(i)}` });
    expect(r.getObserved()).toHaveLength(10);
    expect(r.getStats().droppedByCap).toBe(90);
  });

  it("tracked-key memory is bounded", () => {
    const { r } = make({ maxTrackedKeys: 20, maxReportsPerWindow: 100000, maxObserved: 10 });
    for (let i = 0; i < 500; i++) r.report({ message: `u${"y".repeat(i % 150)}${i}` });
    // @ts-expect-error private, inspected only to prove the bound
    expect(r.tracked.size).toBeLessThanOrEqual(20);
  });

  it("interleaved (concurrent-style) reporting keeps counters consistent", async () => {
    const { r } = make({ maxReportsPerWindow: 1000 });
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => Promise.resolve().then(() => r.report({ message: `kind ${i % 4}` })))
    );
    const s = r.getStats();
    expect(s.accepted + s.coalesced + s.droppedByCap + s.invalid).toBe(200);
    expect(s.accepted).toBe(4);
    expect(r.getObserved().reduce((n, o) => n + o.count, 0)).toBe(200);
  });
});

describe("reporter: production mode", () => {
  it("retains no observations when not in development", () => {
    const { r } = make({ isDev: () => false });
    for (let i = 0; i < 10; i++) r.report({ message: `p${i}${"k".repeat(i)}` });
    expect(r.getObserved()).toEqual([]);
    expect(r.getStats().accepted).toBe(10); // still counted/deliverable, just not retained
  });

  it("the app-wide singleton is development-gated by __DEV__ (true under Jest)", () => {
    technicalReporter.reset();
    reportTechnicalError({ message: "singleton check" });
    expect(technicalReporter.getObserved()).toHaveLength(1);
    technicalReporter.reset();
  });
});

describe("sanitization / privacy", () => {
  const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIzNDU2";
  const secrets = [
    `Bearer ${fakeJwt}`,
    fakeJwt,
    "user.name+tag@example.com",
    "+972 50-123-4567",
    "0501234567",
    "password=hunter2",
    "access_token=abc123def456",
    "refresh_token: zzzz",
    "https://abcd.supabase.co/rest/v1/profiles?select=*&phone=0501234567&email=a@b.co",
    "123e4567-e89b-12d3-a456-426614174000",
    "2026-10-07T10:11:12.123Z",
    "Cookie: sb-session=abcdef",
    "AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  ];

  it.each(secrets)("message never retains: %s", (s) => {
    const out = sanitizeMessage(`failed: ${s} end`);
    expect(out).not.toContain(fakeJwt);
    expect(out).not.toMatch(/@example\.com|hunter2|abc123def456|zzzz|0501234567|050-123|supabase\.co|123e4567|2026-10-07T|sb-session|AKIA/i);
  });

  it("reports built from sensitive error text and context retain none of it", () => {
    const { r } = make();
    r.report({
      error: new Error(`Request to https://x.supabase.co/rest/v1/rpc/f?token=${fakeJwt} failed for a@b.com`),
      context: {
        http_status: 500, rpc: "register_for_session",
        authorization: `Bearer ${fakeJwt}`, access_token: fakeJwt, password: "hunter2", email: "a@b.com", phone: "0501234567",
        session_id: "123e4567-e89b-12d3-a456-426614174000", url: "https://x.supabase.co/?a=b", body: { reason: "free text" },
        headers: { cookie: "x" }, user_id: "123e4567-e89b-12d3-a456-426614174000",
      },
    });
    const text = JSON.stringify(toWirePayload(r.getObserved()[0].report));
    expect(text).not.toMatch(/eyJ|hunter2|a@b\.com|0501234567|123e4567|supabase\.co|free text|cookie|Bearer [A-Za-z0-9]/i);
    expect(r.getObserved()[0].report.context).toEqual({ http_status: 500, rpc: "register_for_session" });
  });

  it("context allowlist drops unknown keys and mistyped values", () => {
    expect(sanitizeContext({ http_status: "500", rpc: "Bad Name!", attempt: -1, retryable: "yes", phase: "transport", network_state: "offline" }))
      .toEqual({ phase: "transport", network_state: "offline" });
    expect(sanitizeContext(null)).toEqual({});
    expect(sanitizeContext([1, 2])).toEqual({});
  });

  it("operation names never carry volatile identifiers or arbitrary text", () => {
    expect(sanitizeOperation("transport/rpc:123e4567-e89b-12d3-a456-426614174000")).toBe("transport/rpc::uuid");
    expect(sanitizeOperation("transport/rest:1234567890")).toBe("transport/rest::n");
    expect(sanitizeOperation("not an operation")).toBe("transport/unspecified");
    expect(sanitizeOperation(undefined)).toBe("transport/unspecified");
  });
});
