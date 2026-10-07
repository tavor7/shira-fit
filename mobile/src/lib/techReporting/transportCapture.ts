/**
 * Generic TRANSPORT failure capture for the Supabase client's fetch (monitoring Phase 3B).
 *
 * Owns ONLY: (a) fetch rejections and (b) non-2xx HTTP responses that are unambiguously technical at this layer.
 * Does NOT own HTTP-2xx RPC results such as {ok:false,...}: the response body is never read, cloned or parsed here
 * (Phase 3C classifies those through the Phase 3A registry). That split also prevents duplicate reports.
 *
 * The wrapper is transparent: it returns the very same Response object (or rethrows the very same error object),
 * and every capture step runs inside try/catch so a bug here can never change what the Supabase client sees.
 *
 * Which non-2xx responses are reported at this layer (evidence: Supabase REST/auth behaviour and this repo's Edge
 * Functions, which return 4xx on purpose for business/validation outcomes):
 *   REPORTED   5xx on any Supabase endpoint (rest, rpc, auth, storage, functions)
 *              408 / 429 on rest, rpc, storage, functions (gateway timeout / throttling)
 *   NOT REPORTED (deferred, documented)
 *              every other 4xx. On /rest: 400/409/406 carry business tokens (RAISE EXCEPTION is a 400), unique/FK
 *              conflicts and .single() misses; 401/403 are expired-session / role-gating states; 404 is ambiguous.
 *              On /auth: wrong password (400), signup validation (422), refresh-token rejections (400/401), user
 *              rate limits (429) are normal product states. On /functions: this repo's functions return 400/401/403/
 *              404/405/409 deliberately. These need body- or caller-level knowledge, which belongs to a later phase.
 *   Aborted requests (AbortError) are cancellations, not failures.
 *   Requests to hosts other than the Supabase project, and the monitoring report RPC itself, are never reported.
 */
import { reportTechnicalError } from "./reporter";
import type { TechnicalErrorInput } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ReportFn = (input: TechnicalErrorInput) => void;

/** The only endpoint the future reporter delivers through. Failures of it are never reported (recursion protection). */
export const MONITORING_REPORT_PATH = "/rest/v1/rpc/report_client_error";

export type EndpointFamily = "rpc" | "rest" | "auth" | "edge" | "storage" | "other";

export interface EndpointInfo {
  family: EndpointFamily;
  /** Stable, allowlisted name (rpc/function/table/auth endpoint), or undefined when not safely nameable. */
  name?: string;
  /** Exact path (no query/fragment) used only for the recursion check; never reported. */
  path: string;
}

const NAME_RE = /^[a-z0-9_-]{1,64}$/;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  const u = (input as { url?: unknown }).url;
  return typeof u === "string" ? u : "";
}

/** Maps a request URL to a safe, stable endpoint descriptor. Returns null for non-Supabase hosts. Never throws. */
export function describeEndpoint(input: RequestInfo | URL, supabaseUrl: string): EndpointInfo | null {
  try {
    const raw = urlOf(input);
    const base = supabaseUrl.replace(/\/+$/, "");
    if (!base || !raw.startsWith(base)) return null;
    const rest = raw.slice(base.length);
    if (rest !== "" && rest[0] !== "/" && rest[0] !== "?" && rest[0] !== "#") return null;
    const path = rest.split(/[?#]/)[0] || "/";
    const seg = path.split("/").filter(Boolean);
    const safe = (s: string | undefined) => (s && NAME_RE.test(s) ? s : undefined);
    if (seg[0] === "rest" && seg[1] === "v1") {
      if (seg[2] === "rpc") return { family: "rpc", name: safe(seg[3]), path };
      return { family: "rest", name: safe(seg[2]), path };
    }
    if (seg[0] === "auth" && seg[1] === "v1") return { family: "auth", name: safe(seg[2]), path };
    if (seg[0] === "functions" && seg[1] === "v1") return { family: "edge", name: safe(seg[2]), path };
    if (seg[0] === "storage" && seg[1] === "v1") return { family: "storage", path };
    return { family: "other", path };
  } catch {
    return null;
  }
}

export interface TransportDecision {
  report: boolean;
  /** Why a non-2xx response is not reported (documentation/test aid). */
  reason?: string;
  severity?: "info" | "warning" | "error";
  retryable?: boolean;
}

/** Decides whether a non-2xx status is an unambiguous technical failure at the generic transport layer. */
export function classifyHttpStatus(family: EndpointFamily, status: number): TransportDecision {
  if (!Number.isFinite(status) || status < 400) return { report: false, reason: "not_an_error" };
  if (status >= 500) {
    const transient = status === 502 || status === 503 || status === 504;
    return { report: true, severity: transient ? "warning" : "error", retryable: transient };
  }
  if ((status === 408 || status === 429) && family !== "auth" && family !== "other") {
    return { report: true, severity: "warning", retryable: true };
  }
  return { report: false, reason: `deferred_${family}_4xx` };
}

function isAbort(err: unknown): boolean {
  try {
    const name = (err as { name?: unknown } | null)?.name;
    return name === "AbortError";
  } catch {
    return false;
  }
}

function operationFor(ep: EndpointInfo): string {
  return `transport/${ep.family}${ep.name ? `:${ep.name}` : ""}`;
}

function contextFor(ep: EndpointInfo, extra: Record<string, unknown>): Record<string, unknown> {
  const ctx: Record<string, unknown> = { phase: "transport", ...extra };
  if (ep.family === "rpc" && ep.name) ctx.rpc = ep.name;
  else if (ep.family === "rest" && ep.name) ctx.table = ep.name;
  else if (ep.family === "edge" && ep.name) ctx.edge_function = ep.name;
  return ctx;
}

function networkState(): string {
  try {
    const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
    return nav && nav.onLine === false ? "offline" : "unknown";
  } catch {
    return "unknown";
  }
}

export interface TransportCaptureOptions {
  supabaseUrl: string;
  report?: ReportFn;
  now?: () => number;
}

/**
 * Wraps a fetch implementation. Install it OUTSIDE any retry/refresh logic so that a request recovered by that
 * logic (e.g. 401 -> refresh -> retry) is judged on its final outcome.
 */
export function withTransportCapture(inner: FetchLike, opts: TransportCaptureOptions): FetchLike {
  const report = opts.report ?? reportTechnicalError;
  const now = opts.now ?? (() => Date.now());

  return async (input, init) => {
    let started = 0;
    let ep: EndpointInfo | null = null;
    try {
      started = now();
      ep = describeEndpoint(input, opts.supabaseUrl);
    } catch {
      ep = null;
    }
    const monitored = ep !== null && ep.path !== MONITORING_REPORT_PATH && ep.family !== "other";

    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      if (monitored && ep && !isAbort(err)) {
        try {
          report({
            operation: operationFor(ep),
            error: err,
            errorClass: "NetworkError",
            errorCode: "network_error",
            severity: "info",
            context: contextFor(ep, {
              network_state: networkState(),
              retryable: true,
              duration_ms: Math.max(0, now() - started),
            }),
          });
        } catch {
          /* never affects the caller */
        }
      }
      throw err; // the very same error object, unchanged
    }

    if (monitored && ep) {
      try {
        const status = response.status;
        if (typeof status === "number" && status >= 400) {
          const d = classifyHttpStatus(ep.family, status);
          if (d.report) {
            report({
              operation: operationFor(ep),
              errorClass: "HttpError",
              errorCode: `http_${status}`,
              message: `HTTP ${status}`,
              severity: d.severity,
              context: contextFor(ep, {
                http_status: status,
                retryable: d.retryable,
                duration_ms: Math.max(0, now() - started),
              }),
            });
          }
        }
      } catch {
        /* never affects the caller */
      }
    }
    return response; // the very same Response object, body untouched
  };
}
