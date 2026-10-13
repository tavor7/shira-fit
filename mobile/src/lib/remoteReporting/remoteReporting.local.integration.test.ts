/// <reference types="node" />
import { execSync } from "child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RpcOutcomeObserver } from "../rpcOutcomes/observer";
import { withTransportCapture } from "../techReporting/transportCapture";
import { startRemoteReporting } from "./index";
import { RemoteReportingPipeline } from "./pipeline";
import type { WirePayload } from "./eligibility";

// LOCAL END-TO-END integration of the Phase 3E.3 client pipeline against a real local Supabase stack (real GoTrue, PostgREST and the real
// Phase 3E.2 server: report_client_error, allowlist, validator, quotas). SKIPPED unless SF_LOCAL_URL is set; never run against production.
//
//   SF_LOCAL_URL=http://127.0.0.1:59421 SF_LOCAL_ANON=... SF_LOCAL_SERVICE=... SF_LOCAL_DB=<db container> npx jest remoteReporting.local
//
// The pipeline is enabled only by constructing a private instance here; the build gate stays false.
const URL0 = process.env.SF_LOCAL_URL;
const ANON = process.env.SF_LOCAL_ANON ?? "";
const SERVICE = process.env.SF_LOCAL_SERVICE ?? "";
const DB = process.env.SF_LOCAL_DB ?? "";
const run = URL0 && URL0.startsWith("http://127.0.0.1") ? describe : describe.skip;

// jest-expo stubs fetch: use Node http and hand back real Response objects
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http") as typeof import("http");
const nodeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const u = new URL(typeof input === "string" ? input : (input as URL).href ?? (input as Request).url);
    const hdrs: Record<string, string> = {};
    const h = init?.headers as unknown;
    if (h && typeof (h as Headers).forEach === "function") (h as Headers).forEach((v, k) => { hdrs[k] = v; });
    else if (h) Object.assign(hdrs, h as Record<string, string>);
    const body = init?.body == null ? undefined : String(init.body);
    if (body !== undefined) hdrs["content-length"] = String(Buffer.byteLength(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init?.method ?? "GET", headers: hdrs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const rh = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) rh.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const st = res.statusCode ?? 0;
        resolve(new Response([204, 205, 304].includes(st) ? null : Buffer.concat(chunks).toString("utf8"), { status: st, headers: rh }));
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const sql = (q: string) => execSync(`docker exec -i ${DB} psql -U postgres -qAt -v ON_ERROR_STOP=1`, { encoding: "utf8", input: q }).trim();
const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)); };

run("Phase 3E.3 local end-to-end against the real server contract", () => {
  jest.setTimeout(120000);
  let uid = "";
  let cfg = "";
  const reports: WirePayload[] = [];
  const results: { sent: number } = { sent: 0 };
  let pipeline: RemoteReportingPipeline;
  let client: SupabaseClient;
  let scriptedFailure: { fn: string; status: number; body: unknown } | null = null;

  beforeAll(async () => {
    cfg = sql("select value::text from public.system_monitoring_config where key='client_ingest_enabled'");
    const email = `e2e-${Date.now()}@t.local`;
    const admin = createClient(URL0!, SERVICE, { auth: { persistSession: false }, global: { fetch: nodeFetch as never } });
    const { data, error } = await admin.auth.admin.createUser({ email, password: "Passw0rd!x", email_confirm: true, user_metadata: { full_name: "e", phone: `05${String(Date.now()).slice(-8)}`, gender: "female", address: "A", zip_code: "1" } });
    if (error) throw error;
    uid = data.user!.id;
    sql(`update public.profiles set approval_status='approved' where user_id='${uid}'; delete from public.system_issues where source='client'; delete from public.system_report_quota;`);
    // the app's own RPCs are scripted (to produce technical outcomes on demand); everything else, including report_client_error, hits the real stack
    const base = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof input === "string" ? input : (input as URL).href ?? (input as Request).url;
      if (u.includes("/rpc/report_client_error")) { results.sent++; try { reports.push((JSON.parse(String(init?.body)) as { p_payload: WirePayload }).p_payload); } catch { /* ignore */ } }
      if (scriptedFailure && u.includes(`/rpc/${scriptedFailure.fn}`)) {
        return new Response(JSON.stringify(scriptedFailure.body), { status: scriptedFailure.status, headers: { "content-type": "application/json" } });
      }
      return nodeFetch(input, init);
    };
    pipeline = new RemoteReportingPipeline({ enabled: () => true, deliver: null });
    client = createClient(URL0!, ANON, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: withTransportCapture(base as never, { supabaseUrl: URL0!, report: (r) => pipeline.submitTransport(r) }) as never },
    });
    startRemoteReporting(client, pipeline, true, new RpcOutcomeObserver({ isEnabled: () => true, aggregate: () => false }));
    const si = await client.auth.signInWithPassword({ email, password: "Passw0rd!x" });
    if (si.error) throw si.error;
    await settle(300);
  });

  afterAll(() => {
    sql(`update public.system_monitoring_config set value='${cfg}'::jsonb where key='client_ingest_enabled'; delete from public.system_issues where source='client'; delete from public.system_report_quota;`);
  });

  it("the auth lifecycle signs the pipeline in; with the server switch OFF the first report returns `disabled`, the breaker pauses, and no issue exists", async () => {
    expect(pipeline.isSignedIn()).toBe(true);
    sql("update public.system_monitoring_config set value='false'::jsonb where key='client_ingest_enabled'");
    scriptedFailure = { fn: "register_for_session", status: 200, body: { ok: false, error: "no_profile" } };
    const r = await client.rpc("register_for_session", { p_session_id: "00000000-0000-0000-0000-000000000000" });
    expect(r.data).toEqual({ ok: false, error: "no_profile" });         // the caller's result is untouched
    await settle();
    expect(results.sent).toBe(1);
    expect(pipeline.getStats()).toMatchObject({ sent: 1, rejected: 1 });
    expect(pipeline.getStats().pausedUntil).toBeGreaterThan(Date.now());
    expect(sql("select count(*) from public.system_issues where source='client'")).toBe("0");
    await client.rpc("register_for_session", {});                       // a second failure while paused: no second request
    await settle();
    expect(results.sent).toBe(1);
  });

  it("server switch ON: a technical RPC outcome creates ONE warning issue with the server-controlled title, attribution and no client text", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0; results.sent = 0;
    sql("update public.system_monitoring_config set value='true'::jsonb where key='client_ingest_enabled'");
    scriptedFailure = { fn: "register_for_session", status: 200, body: { ok: false, error: "no_profile" } };
    await client.rpc("register_for_session", { p_session_id: "00000000-0000-0000-0000-000000000000", secret: "alice@example.com" });
    await settle(800);
    expect(pipeline.getStats()).toMatchObject({ sent: 1, accepted: 1 });
    expect(reports[0]).toMatchObject({ operation: "rpc/register_for_session", error_class: "RpcOutcome", error_code: "no_profile", severity: "warning" });
    expect(sql("select count(*) from public.system_issues where source='client'")).toBe("1");
    expect(sql("select severity||'|'||source||'|'||subsystem||'|'||title||'|'||status from public.system_issues where source='client'")).toBe("warning|client|rpc|RPC technical outcome: register_for_session (no_profile)|open");
    expect(sql("select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client' and e.user_id='" + uid + "' and e.message='RPC technical outcome: register_for_session (no_profile)'")).toBe("1");
    expect(JSON.stringify(reports)).not.toMatch(/alice|secret/);
  });

  it("a REAL PostgREST technical error (PGRST202, wrong arguments) is reported as rpc/postgrest with the RPC name in context", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0; scriptedFailure = null;
    sql("delete from public.system_issues where source='client'; delete from public.system_report_quota");
    const r = await client.rpc("register_for_session", { p_wrong_argument: 1 });
    expect(r.error?.code).toBe("PGRST202");
    await settle(800);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ operation: "rpc/postgrest", error_class: "PostgrestError", error_code: "PGRST202", context: { phase: "rpc_error", rpc: "register_for_session", sqlstate: "PGRST202" } });
    expect(sql("select count(*) from public.system_issues where source='client' and operation='rpc/postgrest' and error_code='PGRST202'")).toBe("1");
  });

  it("an expected 400 (RAISE `forbidden`) and a business outcome send nothing", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0;
    scriptedFailure = { fn: "waitlist_counts", status: 400, body: { code: "P0001", message: "forbidden" } };
    await client.rpc("waitlist_counts", { p_session_ids: [] });
    scriptedFailure = { fn: "register_for_session", status: 200, body: { ok: false, error: "full" } };
    await client.rpc("register_for_session", {});
    await settle(500);
    expect(reports).toHaveLength(0);
  });

  it("transport 503 is reported as transport/infra and accepted by the real server", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0;
    sql("delete from public.system_issues where source='client'; delete from public.system_report_quota");
    scriptedFailure = { fn: "some_rpc", status: 503, body: { message: "down" } };
    await client.rpc("some_rpc");
    await settle(800);
    expect(reports[0]).toMatchObject({ operation: "transport/infra", error_class: "HttpError", error_code: "http_503", context: { http_status: 503, rpc: "some_rpc", phase: "transport", retryable: true } });
    expect(pipeline.getStats().accepted).toBe(1);
    expect(sql("select count(*) from public.system_issues where source='client' and operation='transport/infra'")).toBe("1");
  });

  it("the server rejects a payload outside the allowlist, proving the server (not the client) is the boundary", async () => {
    const r = await client.rpc("report_client_error", { p_payload: { operation: "rpc/register_for_session", error_class: "RpcOutcome", error_code: "full", message: "x" } });
    expect(r.data).toMatchObject({ accepted: false, reason: "not_allowlisted" });
    const bad = await client.rpc("report_client_error", { p_payload: { operation: "rpc/register_for_session", error_class: "RpcOutcome", error_code: "no_profile", user_id: uid } });
    expect(bad.data).toMatchObject({ accepted: false, reason: "invalid_payload" });
  });

  it("a disabled account is rejected by the server (`not_allowed`) and the pipeline pauses until the next sign-in", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0;
    sql(`update public.profiles set disabled_at=now() where user_id='${uid}'; delete from public.system_report_quota`);
    scriptedFailure = { fn: "register_for_session", status: 200, body: { ok: false, error: "no_profile" } };
    await client.rpc("register_for_session", {});
    await settle(800);
    expect(pipeline.getStats()).toMatchObject({ sent: 1, rejected: 1 });
    expect(pipeline.getStats().pausedUntil).toBeGreaterThan(Date.now());
    sql(`update public.profiles set disabled_at=null where user_id='${uid}'`);
  });

  it("sign-out stops reporting (no session => nothing is sent)", async () => {
    pipeline.reset(); pipeline.onAuth("SIGNED_IN", true); reports.length = 0;
    await client.auth.signOut();
    await settle(300);
    expect(pipeline.isSignedIn()).toBe(false);
    scriptedFailure = { fn: "register_for_session", status: 200, body: { ok: false, error: "no_profile" } };
    await client.rpc("register_for_session", {});
    await settle(300);
    expect(reports).toHaveLength(0);
  });
});
