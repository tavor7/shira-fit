import { describeEndpoint } from "../techReporting/transportCapture";
import { isPerfEnabled } from "./perfFlag";
import { perfRequestEnd, perfRequestStart } from "./perfStore";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Transparent fetch wrapper that times Supabase requests while performance instrumentation is enabled
 * (docs/performance/README.md). Disabled (the default): one cached boolean check, then the inner fetch is called with
 * the same arguments and its promise is returned as-is. Enabled: records only a safe endpoint label (via
 * `describeEndpoint`, which drops hosts, ids and query strings), the method, the status and timings. It never reads,
 * clones or alters the request or the response, and returns the very same Response / rethrows the very same error.
 */
export function withPerfTracking(inner: FetchLike, opts: { supabaseUrl: string }): FetchLike {
  return (input, init) => {
    if (!isPerfEnabled()) return inner(input, init);
    let id: number | null = null;
    try {
      const ep = describeEndpoint(input, opts.supabaseUrl);
      if (ep) {
        const label = ep.name ? `${ep.family}:${ep.name}` : ep.family;
        const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
        id = perfRequestStart(label, method);
      }
    } catch {
      id = null;
    }
    return inner(input, init).then(
      (res) => {
        try {
          perfRequestEnd(id, res.status);
        } catch {
          /* ignore */
        }
        return res;
      },
      (err: unknown) => {
        try {
          perfRequestEnd(id, 0);
        } catch {
          /* ignore */
        }
        throw err;
      }
    );
  };
}
