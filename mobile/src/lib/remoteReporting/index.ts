/**
 * Remote technical reporting wiring (monitoring Phase 3E.3). With REMOTE_TECHNICAL_REPORTING_ENABLED === false (the only value in the
 * repository) every entry point is inert: `startRemoteReporting` installs nothing and `remoteReporting.submit*` return immediately.
 */
import { installRpcOutcomeObserver, rpcOutcomeObserver, type OutcomeEvent, type RpcOutcomeObserver } from "../rpcOutcomes/observer";
import { REMOTE_TECHNICAL_REPORTING_ENABLED } from "./config";
import { createRpcDeliverer } from "./delivery";
import type { OutcomeCandidate } from "./eligibility";
import { RemoteReportingPipeline } from "./pipeline";

export { REMOTE_TECHNICAL_REPORTING_ENABLED } from "./config";
export { SERVER_ALLOWLIST, isAllowlisted } from "./allowlist";
export { mapOutcome, mapTransport, transportCandidateFrom, isValidWirePayload } from "./eligibility";
export type { OutcomeCandidate, TransportCandidate, WirePayload } from "./eligibility";
export { RemoteReportingPipeline, DEFAULT_LIMITS } from "./pipeline";
export { createRpcDeliverer } from "./delivery";

/** The app-wide pipeline. Gated by the build-time constant only. */
export const remoteReporting = new RemoteReportingPipeline({ enabled: () => REMOTE_TECHNICAL_REPORTING_ENABLED, deliver: null });

type AuthClient = { auth?: { onAuthStateChange?: (cb: (event: unknown, session: unknown) => void) => unknown } };

/** The observer's failure event as a reporting candidate (codes and the class only). */
export function candidateFromEvent(e: OutcomeEvent): OutcomeCandidate {
  if (e.channel === "result") return { kind: "rpc_result", operation: e.operation, code: e.code, cls: e.class };
  if (e.channel === "reason") return { kind: "rpc_reason", operation: e.operation, code: e.code, cls: e.class };
  return { kind: "postgrest", operation: e.operation, code: e.code, cls: e.class, raised: e.raised };
}

/**
 * Wires the app to a Supabase client: the delivery function, the auth lifecycle listener (a boolean only) and the RPC outcome
 * observer's listener (production: listener only, nothing retained; development keeps its aggregate as before).
 * No-op unless the build-time gate is on. Returns true if it started.
 */
export function startRemoteReporting(
  client: unknown,
  pipeline: RemoteReportingPipeline = remoteReporting,
  enabled: boolean = REMOTE_TECHNICAL_REPORTING_ENABLED,
  observer: RpcOutcomeObserver = rpcOutcomeObserver
): boolean {
  try {
    if (!enabled) return false;
    pipeline.setDeliverer(createRpcDeliverer(client));
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
