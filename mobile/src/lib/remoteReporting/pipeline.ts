/**
 * The client-side remote technical reporting pipeline (monitoring Phase 3E.3): admission (flood control), a bounded in-memory queue,
 * serialized delivery and a circuit breaker. Nothing is persisted; nothing here can reach the caller of the original operation:
 * every public method is total (never throws, never returns a promise the app has to await).
 *
 * While `enabled()` is false, `submit`, `submitTransport` and `onAuth` return immediately: no work, no queue, no request.
 */
import { getBuildInfo, type BuildInfo } from "../techReporting/buildInfo";
import type { Deliverer, DeliveryOutcome } from "./delivery";
import { isValidWirePayload, mapOutcome, mapTransport, transportCandidateFrom, type OutcomeCandidate, type TransportCandidate, type WirePayload } from "./eligibility";

export interface PipelineLimits {
  coalesceMs: number;
  perTenMinutes: number;
  perHour: number;
  maxPending: number;
  maxKeys: number;
  deliveryTimeoutMs: number;
}
export const DEFAULT_LIMITS: PipelineLimits = {
  coalesceMs: 30 * 60_000,
  perTenMinutes: 5,
  perHour: 20,
  maxPending: 10,
  maxKeys: 100,
  deliveryTimeoutMs: 8_000,
};

export interface PipelineOptions {
  enabled: () => boolean;
  deliver: Deliverer | null;
  now?: () => number;
  buildInfo?: () => BuildInfo;
  limits?: Partial<PipelineLimits>;
  /** Test hook: called when the next delivery should be attempted (default: a microtask). */
  schedule?: (fn: () => void) => void;
}

export interface PipelineStats {
  submitted: number;
  ineligible: number;
  notSignedIn: number;
  suppressed: number;
  coalesced: number;
  droppedByCap: number;
  droppedQueueFull: number;
  sent: number;
  accepted: number;
  rejected: number;
  failed: number;
  pending: number;
  pausedUntil: number;
}

const HOUR = 3_600_000;
const SIX_HOURS = 6 * HOUR;

export class RemoteReportingPipeline {
  private readonly enabled: () => boolean;
  private deliverer: Deliverer | null;
  private readonly now: () => number;
  private readonly buildInfo: () => BuildInfo;
  private readonly limits: PipelineLimits;
  private readonly schedule: (fn: () => void) => void;

  private signedIn = false;
  private pending: WirePayload[] = [];
  private inFlight = false;
  private lastAdmitted = new Map<string, number>();
  private admittedAt: number[] = [];
  private suppressedKeys = new Set<string>();
  private pausedUntil = 0;
  private failures = 0;
  private epoch = 0;
  private stats: Omit<PipelineStats, "pending" | "pausedUntil"> = {
    submitted: 0, ineligible: 0, notSignedIn: 0, suppressed: 0, coalesced: 0, droppedByCap: 0, droppedQueueFull: 0, sent: 0, accepted: 0, rejected: 0, failed: 0,
  };

  constructor(opts: PipelineOptions) {
    this.enabled = opts.enabled;
    this.deliverer = opts.deliver;
    this.now = opts.now ?? (() => Date.now());
    this.buildInfo = opts.buildInfo ?? getBuildInfo;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.schedule = opts.schedule ?? ((fn) => void Promise.resolve().then(fn));
  }

  setDeliverer(d: Deliverer | null): void {
    this.deliverer = d;
  }

  /** An RPC outcome seen by the observer (already classified by the Phase 3A-3D classifier). */
  submit(c: OutcomeCandidate): void {
    try {
      if (!this.enabled()) return;
      this.stats.submitted++;
      const draft = mapOutcome(c);
      this.admit(draft);
    } catch {
      /* reporting never affects the caller */
    }
  }

  /** A transport failure as reported by the Phase 3B fetch wrapper (its reporter input). */
  submitTransport(input: unknown): void {
    try {
      if (!this.enabled()) return;
      this.stats.submitted++;
      const cand = transportCandidateFrom(input);
      this.admit(cand ? mapTransport(cand) : null);
    } catch {
      /* reporting never affects the caller */
    }
  }

  /** Direct transport candidate (tests / future callers). */
  submitTransportCandidate(t: TransportCandidate): void {
    try {
      if (!this.enabled()) return;
      this.stats.submitted++;
      this.admit(mapTransport(t));
    } catch {
      /* swallowed */
    }
  }

  /**
   * Auth lifecycle: INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED with a session => signed in; SIGNED_OUT or no
   * session => signed out. Only a boolean is kept (no user id, no token). A new sign-in lifts a pause caused by the previous
   * session (e.g. a disabled account) and forgets session-scoped suppression.
   */
  onAuth(event: unknown, hasSession: boolean): void {
    try {
      if (!this.enabled()) return;
      const was = this.signedIn;
      this.signedIn = hasSession === true && event !== "SIGNED_OUT";
      if (!this.signedIn) {
        this.pending = [];
        if (was) this.epoch++;
        return;
      }
      if (!was || event === "SIGNED_IN") {
        this.epoch++;
        this.pausedUntil = 0;
        this.failures = 0;
        this.suppressedKeys.clear();
      }
      this.pump();
    } catch {
      /* swallowed */
    }
  }

  private admit(draft: ReturnType<typeof mapOutcome>): void {
    if (!draft) {
      this.stats.ineligible++;
      return;
    }
    if (!this.signedIn) {
      this.stats.notSignedIn++;
      return;
    }
    const key = `${draft.operation}|${draft.error_class}|${draft.error_code}`;
    if (this.suppressedKeys.has(key)) {
      this.stats.suppressed++;
      return;
    }
    const t = this.now();
    const last = this.lastAdmitted.get(key);
    if (last !== undefined && t - last < this.limits.coalesceMs) {
      this.stats.coalesced++;
      return;
    }
    this.admittedAt = this.admittedAt.filter((x) => t - x < HOUR);
    const tenMin = this.admittedAt.filter((x) => t - x < 600_000).length;
    if (tenMin >= this.limits.perTenMinutes || this.admittedAt.length >= this.limits.perHour) {
      this.stats.droppedByCap++;
      return;
    }
    if (this.pending.length >= this.limits.maxPending) {
      this.stats.droppedQueueFull++;
      return;
    }
    const b = this.buildInfo();
    const payload: WirePayload = { ...draft, context: { ...draft.context } };
    if (b.appVersion) payload.app_version = b.appVersion;
    if (b.build) payload.build = b.build;
    if (b.platform) payload.platform = b.platform;
    if (b.env) payload.env = b.env;
    if (!isValidWirePayload(payload)) {
      // a field the server would reject (e.g. an unexpected build string): drop the optional fields rather than lose the report
      delete payload.app_version;
      delete payload.build;
      delete payload.env;
      if (!isValidWirePayload(payload)) {
        this.stats.ineligible++;
        return;
      }
    }
    this.lastAdmitted.delete(key);
    this.lastAdmitted.set(key, t);
    while (this.lastAdmitted.size > this.limits.maxKeys) {
      const oldest = this.lastAdmitted.keys().next().value;
      if (oldest === undefined) break;
      this.lastAdmitted.delete(oldest);
    }
    this.admittedAt.push(t);
    this.pending.push(payload);
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || this.pending.length === 0 || !this.signedIn || !this.deliverer) return;
    if (this.now() < this.pausedUntil) return;
    this.schedule(() => void this.deliverNext());
  }

  private async deliverNext(): Promise<void> {
    if (this.inFlight || !this.signedIn || !this.deliverer || this.pending.length === 0) return;
    if (this.now() < this.pausedUntil) return;
    const payload = this.pending.shift() as WirePayload;
    const epoch = this.epoch;
    this.inFlight = true;
    this.stats.sent++;
    let outcome: DeliveryOutcome = { kind: "exception" };
    try {
      outcome = await this.withTimeout(this.deliverer(payload));
    } catch {
      outcome = { kind: "exception" };
    } finally {
      this.inFlight = false;
    }
    try {
      if (epoch === this.epoch) this.handle(payload, outcome);
    } catch {
      /* swallowed */
    }
    this.pump();
  }

  private withTimeout(p: Promise<DeliveryOutcome>): Promise<DeliveryOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "exception" }), this.limits.deliveryTimeoutMs);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        () => { clearTimeout(timer); resolve({ kind: "exception" }); }
      );
    });
  }

  private pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  private backoff(): void {
    this.failures++;
    const ms = Math.min(HOUR, 60_000 * 2 ** Math.min(this.failures - 1, 6));
    this.pause(this.failures >= 3 ? HOUR : ms);
  }

  private handle(payload: WirePayload, o: DeliveryOutcome): void {
    const key = `${payload.operation}|${payload.error_class}|${payload.error_code}`;
    if (o.kind === "http") {
      this.stats.failed++;
      if (o.status === 401 || o.status === 403) this.pause(SIX_HOURS); // no valid session: wait for the next sign-in
      else this.backoff();
      return;
    }
    if (o.kind === "exception") {
      this.stats.failed++;
      this.backoff();
      return;
    }
    if (o.accepted) {
      this.stats.accepted++;
      this.failures = 0;
      return;
    }
    this.stats.rejected++;
    switch (o.reason) {
      case "disabled": // client ingestion is off server-side
      case "not_allowed": // disabled account
      case "unauthenticated":
        this.pending = [];
        this.pause(SIX_HOURS);
        return;
      case "user_quota":
      case "throttled":
      case "user_new_fingerprints":
      case "global_new_fingerprints": {
        const s = Math.min(3600, Math.max(60, o.retryAfterS ?? 3600));
        this.pause(s * 1000);
        return;
      }
      case "not_allowlisted":
      case "ignored":
      case "invalid_payload":
        this.suppressedKeys.add(key);
        if (this.suppressedKeys.size > this.limits.maxKeys) this.suppressedKeys.clear();
        return;
      default: // internal, reentrant, raced, too_large, unknown reasons
        this.backoff();
    }
  }

  getStats(): PipelineStats {
    return { ...this.stats, pending: this.pending.length, pausedUntil: this.pausedUntil };
  }

  isSignedIn(): boolean {
    return this.signedIn;
  }

  reset(): void {
    this.pending = [];
    this.lastAdmitted.clear();
    this.admittedAt = [];
    this.suppressedKeys.clear();
    this.pausedUntil = 0;
    this.failures = 0;
    this.signedIn = false;
    this.inFlight = false;
    this.stats = { submitted: 0, ineligible: 0, notSignedIn: 0, suppressed: 0, coalesced: 0, droppedByCap: 0, droppedQueueFull: 0, sent: 0, accepted: 0, rejected: 0, failed: 0 };
  }
}
