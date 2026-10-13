/**
 * Delivery of one approved report to report_client_error(jsonb) through the NORMAL authenticated Supabase client (the user's own
 * JWT; no service_role credential exists in the app). Never throws; returns a small structured outcome. The request goes through the
 * client's fetch wrapper, which excludes this path (Phase 3B), and the RPC observer ignores this operation, so a failure of the
 * report itself can never be reported again.
 */
import type { WirePayload } from "./eligibility";

export type DeliveryOutcome =
  | { kind: "server"; accepted: boolean; reason?: string; retryAfterS?: number }
  | { kind: "http"; status?: number }
  | { kind: "exception" };

export type Deliverer = (payload: WirePayload) => Promise<DeliveryOutcome>;

type RpcClient = {
  rpc: (fn: string, args?: unknown) => PromiseLike<{ data?: unknown; error?: unknown; status?: unknown }> & { abortSignal?: (s: AbortSignal) => unknown };
};

export const REPORT_RPC = "report_client_error";
export const DELIVERY_TIMEOUT_MS = 5000;

export function createRpcDeliverer(client: unknown, timeoutMs: number = DELIVERY_TIMEOUT_MS): Deliverer {
  return async (payload) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const c = client as RpcClient;
      let builder: unknown = c.rpc(REPORT_RPC, { p_payload: payload });
      try {
        if (typeof AbortController !== "undefined" && builder && typeof (builder as { abortSignal?: unknown }).abortSignal === "function") {
          const ac = new AbortController();
          timer = setTimeout(() => ac.abort(), timeoutMs);
          builder = (builder as { abortSignal: (s: AbortSignal) => unknown }).abortSignal(ac.signal);
        }
      } catch {
        /* no timeout support: the pipeline's own timeout still bounds the wait */
      }
      const res = (await (builder as PromiseLike<{ data?: unknown; error?: unknown; status?: unknown }>)) ?? {};
      if (res.error) return { kind: "http", status: typeof res.status === "number" ? res.status : undefined };
      const d = res.data as { accepted?: unknown; reason?: unknown; retry_after_s?: unknown } | null;
      if (!d || typeof d !== "object") return { kind: "exception" };
      return {
        kind: "server",
        accepted: d.accepted === true,
        reason: typeof d.reason === "string" && /^[a-z_]{1,40}$/.test(d.reason) ? d.reason : undefined,
        retryAfterS: typeof d.retry_after_s === "number" && Number.isFinite(d.retry_after_s) ? d.retry_after_s : undefined,
      };
    } catch {
      return { kind: "exception" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
