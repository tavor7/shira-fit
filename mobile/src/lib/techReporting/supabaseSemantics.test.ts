/**
 * Proves the transport wrapper is transparent to the REAL supabase-js client: identical results/errors with and
 * without it, for success, ok:false-in-200, HTTP errors, network failure, auth and Edge Function calls.
 */
import { createClient } from "@supabase/supabase-js";
import { TechnicalReporter } from "./reporter";
import { withTransportCapture } from "./transportCapture";

const URL0 = "https://proj.supabase.co";

type Scripted = { status: number; body: unknown } | "network";

function scripted(responses: Record<string, Scripted>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
    const key = Object.keys(responses).find((k) => u.includes(k));
    const r = key ? responses[key] : { status: 200, body: [] };
    if (r === "network") throw new TypeError("Network request failed");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "x-extra": "1" } });
  };
}

function clients(responses: Record<string, Scripted>) {
  const base = scripted(responses);
  const reporter = new TechnicalReporter({ isDev: () => true, buildInfo: () => ({}), maxReportsPerWindow: 1000 });
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const plain = createClient(URL0, "anon-key", { ...opts, global: { fetch: base as never } });
  const wrapped = createClient(URL0, "anon-key", {
    ...opts,
    global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0, report: (r) => reporter.report(r) }) as never },
  });
  return { plain, wrapped, reporter };
}

const shape = (e: unknown) => (e && typeof e === "object" ? JSON.parse(JSON.stringify({ ...(e as object), name: (e as Error).name, message: (e as Error).message })) : e);

async function both<T>(responses: Record<string, Scripted>, run: (c: ReturnType<typeof clients>["plain"]) => PromiseLike<T>) {
  const c = clients(responses);
  const a = await run(c.plain);
  const b = await run(c.wrapped);
  return { a, b, reporter: c.reporter };
}

describe("wrapped client behaves exactly like the plain client", () => {
  it("rpc 200 with {ok:false} is untouched and unreported", async () => {
    const { a, b, reporter } = await both({ "/rpc/register_for_session": { status: 200, body: { ok: false, error: "full" } } }, (c) => c.rpc("register_for_session", { p_session_id: "x" }));
    expect(b).toEqual(a);
    expect(b.data).toEqual({ ok: false, error: "full" });
    expect(reporter.getObserved()).toEqual([]);
  });

  it("table read 200 is untouched and unreported", async () => {
    const { a, b, reporter } = await both({ "/rest/v1/profiles": { status: 200, body: [{ user_id: "u1" }] } }, (c) => c.from("profiles").select("user_id"));
    expect(b).toEqual(a);
    expect(reporter.getObserved()).toEqual([]);
  });

  it("rpc HTTP 503 yields the same error to the app and exactly one candidate report", async () => {
    const { a, b, reporter } = await both({ "/rpc/f": { status: 503, body: { message: "upstream down", code: "PGRST000" } } }, (c) => c.rpc("f"));
    expect(shape(b.error)).toEqual(shape(a.error));
    expect(b.status).toBe(a.status);
    expect(reporter.getObserved()).toHaveLength(1);
    expect(reporter.getObserved()[0].report).toMatchObject({ operation: "transport/rpc:f", errorCode: "http_503" });
  });

  it("business-style HTTP 400 (e.g. RAISE token) reaches the app unchanged and is not reported", async () => {
    const { a, b, reporter } = await both({ "/rest/v1/athlete_account_payments": { status: 400, body: { code: "P0001", message: "account_disabled_payee" } } }, (c) => c.from("athlete_account_payments").insert({ x: 1 }));
    expect(shape(b.error)).toEqual(shape(a.error));
    expect(reporter.getObserved()).toEqual([]);
  });

  it("network failure surfaces the same error to the app and one candidate report", async () => {
    const { a, b, reporter } = await both({ "/rest/v1/rpc/g": "network" }, (c) => c.rpc("g"));
    // postgrest-js embeds the JS stack trace in `details`, which naturally lists the extra wrapper frame: compare the stable fields
    const pick = (e: unknown) => { const o = e as { message: string; code: string; hint: string }; return { message: o.message, code: o.code, hint: o.hint }; };
    expect(pick(b.error)).toEqual(pick(a.error));
    expect(reporter.getObserved()).toHaveLength(1);
    expect(reporter.getObserved()[0].report.errorCode).toBe("network_error");
  });

  it("auth: wrong password (HTTP 400) is returned unchanged and not reported", async () => {
    const body = { error: "invalid_grant", error_code: "invalid_credentials", msg: "Invalid login credentials" };
    const { a, b, reporter } = await both({ "/auth/v1/token": { status: 400, body } }, (c) => c.auth.signInWithPassword({ email: "u@example.com", password: "pw" }));
    expect(shape(b.error)).toEqual(shape(a.error));
    expect(b.data).toEqual(a.data);
    expect(reporter.getObserved()).toEqual([]);
  });

  it("auth: provider failure (HTTP 500) is returned unchanged and reported once", async () => {
    const { a, b, reporter } = await both({ "/auth/v1/token": { status: 500, body: { msg: "unexpected" } } }, (c) => c.auth.signInWithPassword({ email: "u@example.com", password: "pw" }));
    expect(shape(b.error)).toEqual(shape(a.error));
    expect(reporter.getObserved()).toHaveLength(1);
    expect(reporter.getObserved()[0].report.operation).toBe("transport/auth:token");
  });

  it("Edge Function 4xx is returned unchanged and not reported; 5xx is reported once", async () => {
    const r4 = await both({ "/functions/v1/staff-confirm-email": { status: 403, body: { ok: false, error: "forbidden" } } }, (c) => c.functions.invoke("staff-confirm-email", { body: { user_id: "x" } }));
    expect(shape(r4.b.error)).toEqual(shape(r4.a.error));
    expect(r4.reporter.getObserved()).toEqual([]);
    const r5 = await both({ "/functions/v1/generate-document-pdf": { status: 500, body: { ok: false, error: "x" } } }, (c) => c.functions.invoke("generate-document-pdf", { body: {} }));
    expect(shape(r5.b.error)).toEqual(shape(r5.a.error));
    expect(r5.reporter.getObserved()).toHaveLength(1);
    expect(r5.reporter.getObserved()[0].report.context.edge_function).toBe("generate-document-pdf");
  });

  it("response status, headers and body remain available to a direct caller", async () => {
    const base = scripted({ "/rest/v1/x": { status: 200, body: { a: 1 } } });
    const wrapped = withTransportCapture(base as never, { supabaseUrl: URL0, report: () => undefined });
    const res = await wrapped(`${URL0}/rest/v1/x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-extra")).toBe("1");
    expect(await res.json()).toEqual({ a: 1 });
  });
});
