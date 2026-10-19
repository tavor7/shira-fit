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
 */
import { createRpcDeliverer } from "../remoteReporting/delivery";
import { getServerReportingFlag, type ReportingFlagRpcClient } from "../remoteReporting/serverFlag";
import { technicalReporter } from "./reporter";
import type { ReportWirePayload } from "./types";

/** Installs the deliverer. Call once per app session with the real Supabase client. Never throws. */
export function installTechnicalReportingDeliverer(client: unknown): void {
  try {
    const flag = getServerReportingFlag(client as ReportingFlagRpcClient);
    const rpcDeliver = createRpcDeliverer(client);

    technicalReporter.setDeliverer((payload: ReportWirePayload) => {
      if (!flag.isEnabled()) return;
      // ReportWirePayload (operation/error_class/error_code/message/severity/context/app_version/
      // build/platform/env) is wire-compatible with what createRpcDeliverer forwards as p_payload -
      // both ultimately become the same report_client_error(jsonb) call.
      return rpcDeliver(payload as unknown as Parameters<typeof rpcDeliver>[0]);
    });
  } catch {
    /* never affects app startup */
  }
}
