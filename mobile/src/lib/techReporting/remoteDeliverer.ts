/**
 * Wires the Phase 3B technical reporter (crashes, global handlers, error boundaries - see
 * reporter.ts) to the network, which nothing did before the monitoring completion pass ("Phase 3B
 * installs none"). This is a DIFFERENT channel from remoteReporting/ (which only ever carries
 * reviewed RPC-outcome/transport candidates against a local allowlist mirror): generic crashes have
 * no local allowlist to mirror, so authorization here is left entirely to the server's existing
 * default-deny system_issue_rules.authorizes_client check inside report_client_error - a client bug
 * in this file can make MORE reports attempt delivery, never make the server accept more of them.
 *
 * Gated the same way as remoteReporting: the server's system_client_reporting_enabled() flag
 * (serverFlag.ts), checked fresh on every report, zero network attempt when it reads disabled.
 *
 * Transport-capture failures are the one exception: supabase.ts's fetch wrapper feeds the SAME
 * transport failure to both this reporter (via reportTechnicalError) and remoteReporting (via
 * submitTransport) in the same call. remoteReporting owns that family exclusively - it normalizes the
 * raw per-endpoint operation string that transportCapture.ts produces (`transport/<family>[:name]`,
 * family one of rpc/rest/auth/edge/storage - see EndpointFamily in transportCapture.ts) down to the
 * fixed, allowlisted shape ("transport/infra"/"transport/server") before sending. This reporter never
 * does that normalization, so one of those raw, per-endpoint operations reaching here was never (and
 * per the "do not broaden the allowlist" instruction, must not become) an allowlisted tuple - every such
 * attempt is a guaranteed, wasted round trip to report_client_error that only ever comes back
 * not_allowlisted. Confirmed via production browser testing: every transport failure produced exactly
 * this duplicate, guaranteed-reject call. Skipping it here is not a security change (the server's
 * default-deny already rejected it) - it just stops sending a request that can never succeed.
 *
 * Deliberately NOT a blanket "transport/" prefix match: sanitize.ts's sanitizeOperation() falls back to
 * the literal string "transport/unspecified" for ANY caller (global handlers, error boundary, init
 * failures, or a future caller) whose operation is missing or fails validation - a generic catch-all,
 * not a transport-capture failure, and remoteReporting never produces or handles that string. A blanket
 * prefix match would silently suppress that fallback too, with nothing else ever reporting it.
 */
import { createRpcDeliverer } from "../remoteReporting/delivery";
import { getServerReportingFlag, type ReportingFlagRpcClient } from "../remoteReporting/serverFlag";
import { technicalReporter } from "./reporter";
import type { ReportWirePayload } from "./types";

/** Matches only the raw operation shapes transportCapture.ts's operationFor() actually produces. */
const TRANSPORT_CAPTURE_OPERATION_RE = /^transport\/(rpc|rest|auth|edge|storage)(:|$)/;

/** Installs the deliverer. Call once per app session with the real Supabase client. Never throws. */
export function installTechnicalReportingDeliverer(client: unknown): void {
  try {
    const flag = getServerReportingFlag(client as ReportingFlagRpcClient);
    const rpcDeliver = createRpcDeliverer(client);

    technicalReporter.setDeliverer((payload: ReportWirePayload) => {
      if (!flag.isEnabled()) return;
      if (TRANSPORT_CAPTURE_OPERATION_RE.test(payload.operation)) return; // owned exclusively by remoteReporting's normalized mapping
      // ReportWirePayload (operation/error_class/error_code/message/severity/context/app_version/
      // build/platform/env) is wire-compatible with what createRpcDeliverer forwards as p_payload -
      // both ultimately become the same report_client_error(jsonb) call.
      return rpcDeliver(payload as unknown as Parameters<typeof rpcDeliver>[0]);
    });
  } catch {
    /* never affects app startup */
  }
}
