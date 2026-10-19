/**
 * Remote technical reporting wiring (monitoring Phase 3E.3, reworked by the monitoring completion
 * pass to be server-gated rather than build-gated - see serverFlag.ts for the full rationale).
 *
 * The release-ready build installs the observer and deliverer unconditionally; the pipeline's own
 * `enabled()` callback is re-read on every submit and reflects the server's live
 * system_client_reporting_enabled() flag (cached, refreshed periodically, fails closed). There is
 * no longer a build-time boolean that must also be true - disabling or enabling reporting in
 * production is a single server config change, not a new app deployment.
 */
import { installRpcOutcomeObserver, rpcOutcomeObserver, type OutcomeEvent, type RpcOutcomeObserver } from "../rpcOutcomes/observer";
import { REMOTE_TECHNICAL_REPORTING_ENABLED } from "./config";
import { createRpcDeliverer } from "./delivery";
import type { OutcomeCandidate } from "./eligibility";
import { RemoteReportingPipeline } from "./pipeline";
import { getServerReportingFlag, type ReportingFlagRpcClient } from "./serverFlag";

export { REMOTE_TECHNICAL_REPORTING_ENABLED } from "./config";
export { SERVER_ALLOWLIST, isAllowlisted } from "./allowlist";
export { mapOutcome, mapTransport, transportCandidateFrom, isValidWirePayload } from "./eligibility";
export type { OutcomeCandidate, TransportCandidate, WirePayload } from "./eligibility";
export { RemoteReportingPipeline, DEFAULT_LIMITS } from "./pipeline";
export { createRpcDeliverer } from "./delivery";
export { ServerReportingFlag, getServerReportingFlag, resetServerReportingFlagForTests } from "./serverFlag";

/**
 * The app-wide pipeline. `enabled` starts as the old build-time constant (false in the repository)
 * so an app that never calls startRemoteReporting (e.g. a test harness) stays inert by default;
 * startRemoteReporting below rebinds it to the live server-flag check once a real client exists.
 */
export const remoteReporting = new RemoteReportingPipeline({ enabled: () => REMOTE_TECHNICAL_REPORTING_ENABLED, deliver: null });

type AuthClient = { auth?: { onAuthStateChange?: (cb: (event: unknown, session: unknown) => void) => unknown } };

/** The observer's failure event as a reporting candidate (codes and the class only). */
export function candidateFromEvent(e: OutcomeEvent): OutcomeCandidate {
  if (e.channel === "result") return { kind: "rpc_result", operation: e.operation, code: e.code, cls: e.class };
  if (e.channel === "reason") return { kind: "rpc_reason", operation: e.operation, code: e.code, cls: e.class };
  return { kind: "postgrest", operation: e.operation, code: e.code, cls: e.class, raised: e.raised };
}

/**
 * Wires the app to a Supabase client: the delivery function, the auth lifecycle listener (a boolean
 * only), the RPC outcome observer's listener, and the server reporting flag's first read + periodic
 * refresh. Installs unconditionally (the server flag - not a build-time snapshot - decides whether
 * anything is actually ever submitted), so a later server-side enable takes effect without a new
 * build. Returns true if it started.
 */
export function startRemoteReporting(
  client: unknown,
  pipeline: RemoteReportingPipeline = remoteReporting,
  observer: RpcOutcomeObserver = rpcOutcomeObserver,
  /**
   * Rebinds pipeline.enabled() to the live server flag. Defaults to true for real app wiring; tests
   * that construct their own pipeline with a deliberate `enabled` (e.g. to isolate server-side
   * rejection behavior from the client-side gate) pass false to keep their own wiring intact.
   */
  useServerFlag: boolean = true
): boolean {
  try {
    const flag = getServerReportingFlag(client as ReportingFlagRpcClient);
    pipeline.setDeliverer(createRpcDeliverer(client));
    if (useServerFlag) {
      pipeline.setEnabled(() => flag.isEnabled());
      flag.refresh().catch(() => undefined);
    }
    flag.startPeriodicRefresh();

    const dev = typeof __DEV__ !== "undefined" && __DEV__ === true;
    observer.configure({
      isEnabled: () => true,
      aggregate: () => dev,
      onOutcome: (e) => pipeline.submit(candidateFromEvent(e)),
    });
    installRpcOutcomeObserver(client, observer);
    const auth = (client as AuthClient).auth;
    if (auth && typeof auth.onAuthStateChange === "function") {
      auth.onAuthStateChange((event, session) => {
        try {
          pipeline.onAuth(event, session !== null && session !== undefined);
        } catch {
          /* never affects authentication */
        }
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Call when the app returns to the foreground, so a production flag flip is picked up promptly. */
export function refreshRemoteReportingFlagOnForeground(client: unknown): void {
  try {
    getServerReportingFlag(client as ReportingFlagRpcClient)
      .refresh()
      .catch(() => undefined);
  } catch {
    /* never affects app lifecycle */
  }
}
