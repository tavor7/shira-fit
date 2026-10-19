/**
 * installTechnicalReportingDeliverer (monitoring completion pass, "SHIRA FIT - FIX CLIENT REPORTING
 * AUTH/FLAG RACE" follow-up): confirmed via a real production browser test that every transport-capture
 * failure produced TWO report_client_error requests - one from remoteReporting's normalized mapping
 * (transport/infra|transport/server, allowlisted), and a second, always-rejected one from this generic
 * channel using the raw, per-endpoint operation string (e.g. "transport/rpc:get_current_legal_document"),
 * which was never allowlisted and must not become allowlisted (that family is remoteReporting's alone).
 * These tests pin the fix: this channel must skip the raw transport-capture shapes rather than send a
 * call that can only ever come back not_allowlisted - but must NOT suppress "transport/unspecified",
 * sanitize.ts's generic fallback for any caller's missing/malformed operation, which has no equivalent
 * reporting path and must still be attempted like any other generic crash report.
 */
import { getServerReportingFlag, resetServerReportingFlagForTests } from "../remoteReporting/serverFlag";
import { installTechnicalReportingDeliverer } from "./remoteDeliverer";
import { technicalReporter } from "./reporter";

afterEach(() => {
  resetServerReportingFlagForTests();
  technicalReporter.setDeliverer(null);
  technicalReporter.reset();
});

function mkClient(flagEnabled: boolean) {
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: jest.fn((fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "system_client_reporting_enabled") return Promise.resolve({ data: flagEnabled, error: null });
      return Promise.resolve({ data: { ok: true, accepted: true, reason: null, retry_after_s: null }, error: null });
    }),
  };
  return { client, rpcCalls };
}

/** Installs the deliverer and makes sure the flag is already resolved before any report() call. */
async function installWithResolvedFlag(flagEnabled: boolean) {
  const { client, rpcCalls } = mkClient(flagEnabled);
  installTechnicalReportingDeliverer(client);
  await getServerReportingFlag(client as never).refresh();
  return { client, rpcCalls };
}

describe("installTechnicalReportingDeliverer", () => {
  it("delivers a non-transport operation normally once the flag is enabled", async () => {
    const { rpcCalls } = await installWithResolvedFlag(true);
    technicalReporter.report({ operation: "client/unhandled_rejection", error: new Error("boom"), severity: "warning" });
    await Promise.resolve();
    expect(rpcCalls.some((c) => c.fn === "report_client_error")).toBe(true);
  });

  it("never sends a raw transport-capture operation (transport/rpc|rest|auth|edge|storage): owned exclusively by remoteReporting's normalized mapping", async () => {
    const { rpcCalls } = await installWithResolvedFlag(true);
    for (const operation of [
      "transport/rpc:get_current_legal_document", "transport/rpc", "transport/rest:some_table", "transport/rest",
      "transport/auth:token", "transport/auth", "transport/edge:some_function", "transport/edge", "transport/storage",
    ]) {
      technicalReporter.report({ operation, errorClass: "HttpError", errorCode: "http_503", severity: "warning", context: { http_status: 503 } });
    }
    await Promise.resolve();
    expect(rpcCalls.some((c) => c.fn === "report_client_error")).toBe(false);
  });

  it("does NOT suppress transport/unspecified: sanitize.ts's generic fallback for a missing/malformed operation has no equivalent path in remoteReporting and must still be attempted", async () => {
    const { rpcCalls } = await installWithResolvedFlag(true);
    // No `operation` supplied at all -> reporter.build() -> sanitizeOperation(undefined) -> "transport/unspecified".
    technicalReporter.report({ message: "something crashed with no operation context", severity: "warning" });
    await Promise.resolve();
    const sent = rpcCalls.find((c) => c.fn === "report_client_error");
    expect(sent).toBeDefined();
    expect((sent?.args as { p_payload: { operation: string } }).p_payload.operation).toBe("transport/unspecified");
  });

  it("the normalized operations remoteReporting itself produces (transport/infra, transport/server) are not raw transport-capture shapes and are also unaffected by the exclusion", async () => {
    // These strings never actually reach this deliverer in production (they only exist inside
    // remoteReporting's own eligibility.ts mapping, delivered through its own separate deliverer) -
    // this just pins that the regex is a prefix+family match, not a bare "transport/" prefix match.
    const { rpcCalls } = await installWithResolvedFlag(true);
    technicalReporter.report({ operation: "transport/infra", errorClass: "HttpError", errorCode: "http_503", severity: "warning", context: { http_status: 503 } });
    await Promise.resolve();
    expect(rpcCalls.some((c) => c.fn === "report_client_error")).toBe(true);
  });

  it("a non-transport operation is unaffected by the exclusion", async () => {
    const { rpcCalls } = await installWithResolvedFlag(true);
    technicalReporter.report({ operation: "client/unhandled_rejection", severity: "warning", context: { phase: "transport" } });
    await Promise.resolve();
    expect(rpcCalls.some((c) => c.fn === "report_client_error")).toBe(true);
  });

  it("still sends nothing at all while the flag is disabled, transport-capture or not", async () => {
    const { rpcCalls } = await installWithResolvedFlag(false);
    technicalReporter.report({ operation: "client/unhandled_rejection", severity: "warning" });
    technicalReporter.report({ operation: "transport/rpc:x", errorClass: "HttpError", errorCode: "http_503", severity: "warning", context: { http_status: 503 } });
    await Promise.resolve();
    expect(rpcCalls.some((c) => c.fn === "report_client_error")).toBe(false);
  });
});
