/**
 * RPC outcome OBSERVATION (monitoring Phase 3C): OBSERVATION ONLY.
 *
 * Connects the Phase 3A classification registry to the real Supabase RPC execution path so that a SUCCESSFUL RPC response whose
 * body is an application-level negative outcome (`{ ok: false, error: "<code>" }`, HTTP 2xx) can be classified centrally.
 *
 *   - It never reports anything remotely: this module does not import the Phase 3B reporter, installs no delivery hook and never
 *     calls the Phase 1 ingestion RPC. Nothing leaves the device.
 *   - It never changes what the caller sees: the observer is invoked from inside the promise chain with the very same result
 *     object, in the same tick, and every step is inside try/catch.
 *   - Evidence is a bounded in-memory aggregate (operation, code, class, count, first/last time). No ids, arguments, response
 *     bodies, messages or stacks are retained: only an allowlisted operation name and a code-shaped string.
 *   - It is installed (and active) only in development builds (`__DEV__`); a production build installs nothing and does no work.
 *
 * Ownership boundary with Phase 3B (prevents double observation):
 *   transport failure / non-2xx / PostgREST `error` result  -> Phase 3B (fetch layer). This observer ignores any result whose
 *                                                              `error` is set, and never sees a rejected promise.
 *   HTTP 2xx with `data.ok === false`                       -> this observer (the transport layer never reads bodies).
 */
import { classifyRpcOutcome } from "./classify";
import type { Classification, OutcomeClass } from "./types";

export interface RpcOutcomeObservation {
  operation: string;
  code: string;
  class: OutcomeClass;
  source: Classification["source"];
  /** The class is technical: a candidate for a later, separately approved remote-reporting phase. Nothing is reported now. */
  futureReportable: boolean;
  /** The pair is uncertain or unknown: the registry needs a human decision. */
  needsReview: boolean;
  /** The operation can return raw database text as its error (the text itself is never retained). */
  dynamicErrorPossible: boolean;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface RpcOutcomeSnapshot {
  observations: RpcOutcomeObservation[];
  totals: Record<OutcomeClass | "malformed", number>;
  /** Observations for distinct operation/code pairs beyond the capacity bound (counted, not stored). */
  overflow: number;
  /** Results inspected (any shape) while the observer was active. */
  inspected: number;
}

export interface RpcOutcomeObserverOptions {
  now?: () => number;
  /** Observation is active only when this returns true (development/test). */
  isEnabled?: () => boolean;
  maxKeys?: number;
}

const OP_RE = /^[a-z0-9_]{1,64}$/;
const CODE_RE = /^[a-z0-9_:.-]{1,64}$/;
const NON_CODE = "<non_code>";
const OTHER_OP = "<other_operation>";
const NO_CODE = "<no_code>";

function emptyTotals(): RpcOutcomeSnapshot["totals"] {
  return { business: 0, authorization_validation: 0, technical: 0, uncertain: 0, unknown: 0, malformed: 0 };
}

export class RpcOutcomeObserver {
  private readonly now: () => number;
  private readonly isEnabled: () => boolean;
  private readonly maxKeys: number;
  private map = new Map<string, RpcOutcomeObservation>();
  private totals = emptyTotals();
  private overflow = 0;
  private inspected = 0;

  constructor(opts: RpcOutcomeObserverOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.isEnabled = opts.isEnabled ?? (() => typeof __DEV__ !== "undefined" && __DEV__ === true);
    this.maxKeys = opts.maxKeys ?? 200;
  }

  /**
   * Inspect one resolved supabase-js result. NEVER throws, NEVER mutates `result`, O(1) (reads a few properties only; arrays,
   * scalars and large bodies are not iterated, stringified or cloned). Returns nothing.
   */
  observe(operation: unknown, result: unknown): void {
    try {
      if (!this.isEnabled()) return;
      if (typeof result !== "object" || result === null) return;
      this.inspected++;
      const r = result as { data?: unknown; error?: unknown };
      if (r.error) return; // a PostgREST/transport error result belongs to Phase 3B
      const data = r.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const d = data as { ok?: unknown; error?: unknown };
      if (d.ok !== false) return; // successful results and shapes without the negative flag are not outcomes

      const op = typeof operation === "string" && OP_RE.test(operation) ? operation : OTHER_OP;
      const rawCode = d.error;
      let code: string;
      let malformed = false;
      if (typeof rawCode === "string") {
        code = CODE_RE.test(rawCode) ? rawCode : NON_CODE; // raw database text is never retained
      } else {
        code = NO_CODE;
        malformed = true;
      }

      // Classification is registry-driven (operation + code). Placeholders are never registered, so they stay UNKNOWN.
      const c = classifyRpcOutcome(op, code);
      const key = `${op}|${code}`;
      const t = this.now();
      const existing = this.map.get(key);
      if (existing) {
        existing.count++;
        existing.lastAt = t;
      } else if (this.map.size < this.maxKeys) {
        this.map.set(key, {
          operation: op,
          code,
          class: c.class,
          source: c.source,
          futureReportable: c.class === "technical",
          needsReview: c.class === "uncertain" || c.class === "unknown",
          dynamicErrorPossible: c.dynamicErrorPossible === true,
          count: 1,
          firstAt: t,
          lastAt: t,
        });
      } else {
        this.overflow++;
      }
      this.totals[malformed ? "malformed" : c.class]++;
    } catch {
      /* observation must never affect the caller */
    }
  }

  getSnapshot(): RpcOutcomeSnapshot {
    return {
      observations: [...this.map.values()].map((o) => ({ ...o })),
      totals: { ...this.totals },
      overflow: this.overflow,
      inspected: this.inspected,
    };
  }

  reset(): void {
    this.map.clear();
    this.totals = emptyTotals();
    this.overflow = 0;
    this.inspected = 0;
  }
}

/** The app-wide observer. */
export const rpcOutcomeObserver = new RpcOutcomeObserver();

const INSTALLED = Symbol.for("shirafit.rpcOutcomeObserver.installed");

type ThenFn = (onfulfilled?: unknown, onrejected?: unknown) => unknown;
type RpcFn = (fn: string, args?: unknown, options?: unknown) => unknown;

/**
 * Wraps `client.rpc`: each returned builder gets an own `then` that forwards to the original with a fulfilment wrapper which
 * first lets the observer look at the resolved result, then hands the identical value to the caller's handler.
 * Safe because (verified for @supabase/postgrest-js 2.112.2): `rpc()` returns a PostgrestFilterBuilder; its chain modifiers
 * (`single`, `maybeSingle`, `throwOnError`, `abortSignal`, `setHeader`, `select`, ...) return `this`, so the patched `then`
 * survives chaining; the request is only sent when `then` is called, retries happen inside `then`, and the fulfilment value is
 * the final `{ data, error, ... }` object. A rejected promise (throwOnError / abort) bypasses the wrapper unchanged.
 * Installing twice is a no-op. Returns true if it installed.
 */
export function installRpcOutcomeObserver(client: unknown, observer: RpcOutcomeObserver = rpcOutcomeObserver): boolean {
  try {
    const c = client as { rpc?: unknown; [INSTALLED]?: boolean };
    if (!c || typeof c.rpc !== "function" || c[INSTALLED]) return false;
    const original = (c.rpc as RpcFn).bind(client);
    const wrapped: RpcFn = (fn, args, options) => {
      const builder = original(fn, args, options);
      try {
        const b = builder as { then?: unknown } | null;
        if (b && typeof b.then === "function") {
          const origThen = b.then as ThenFn;
          (b as { then: ThenFn }).then = function patchedThen(this: unknown, onfulfilled?: unknown, onrejected?: unknown) {
            const forward = (value: unknown) => {
              try {
                observer.observe(fn, value);
              } catch {
                /* an observer fault must never reach the caller */
              }
              return typeof onfulfilled === "function" ? (onfulfilled as (v: unknown) => unknown)(value) : value;
            };
            return origThen.call(this, forward, onrejected);
          };
        }
      } catch {
        /* never affect the caller: the unpatched builder is returned */
      }
      return builder;
    };
    (c as { rpc: unknown }).rpc = wrapped;
    c[INSTALLED] = true;
    return true;
  } catch {
    return false;
  }
}
