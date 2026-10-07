/**
 * The central client technical reporter (monitoring Phase 3B).
 *
 *   reportTechnicalError(input)  -- fire and forget; NEVER throws, NEVER blocks, NEVER touches UI/auth/navigation.
 *
 * In Phase 3B nothing is delivered anywhere: client ingestion is disabled server-side and no deliverer is installed.
 * What WOULD be reported is observable through a bounded, in-memory, development/test-only sink so the architecture
 * can be validated before ingestion is turned on. In a production build (`__DEV__ === false`) the sink is inert.
 *
 * Lightweight client flood protection (the server's quotas remain authoritative):
 *   - identical reports inside a short window are coalesced into one (count incremented, nothing re-delivered)
 *   - a global cap of reports per window; excess is dropped
 *   - bounded key tracking and a bounded observation buffer
 *   - no retries, no persistence, no queue that can grow: monitoring fails OPEN (a dropped report is acceptable)
 */
import { getBuildInfo, type BuildInfo } from "./buildInfo";
import {
  sanitizeContext,
  sanitizeErrorClass,
  sanitizeErrorCode,
  sanitizeMessage,
  sanitizeOperation,
  sanitizeSeverity,
} from "./sanitize";
import type {
  ClientTechnicalReport,
  ObservedReport,
  ReportDeliverer,
  ReportWirePayload,
  TechnicalErrorInput,
} from "./types";

export interface ReporterOptions {
  now?: () => number;
  /** Observation sink is active only when this returns true (development/test). */
  isDev?: () => boolean;
  buildInfo?: () => BuildInfo;
  windowMs?: number;
  maxObserved?: number;
  maxTrackedKeys?: number;
  maxReportsPerWindow?: number;
}

export interface ReporterStats {
  accepted: number;
  coalesced: number;
  droppedByCap: number;
  invalid: number;
}

export function toWirePayload(r: ClientTechnicalReport): ReportWirePayload {
  const p: ReportWirePayload = {
    operation: r.operation,
    error_class: r.errorClass,
    message: r.message,
    severity: r.severity,
    context: { ...r.context },
  };
  if (r.errorCode) p.error_code = r.errorCode;
  if (r.appVersion) p.app_version = r.appVersion;
  if (r.build) p.build = r.build;
  if (r.platform) p.platform = r.platform;
  if (r.env) p.env = r.env;
  return p;
}

function readProp(obj: unknown, key: string): unknown {
  try {
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

export class TechnicalReporter {
  private readonly now: () => number;
  private readonly isDev: () => boolean;
  private readonly buildInfo: () => BuildInfo;
  private readonly windowMs: number;
  private readonly maxObserved: number;
  private readonly maxTrackedKeys: number;
  private readonly maxPerWindow: number;

  private observed: ObservedReport[] = [];
  private tracked = new Map<string, { firstAt: number; entry?: ObservedReport }>();
  private recent: number[] = [];
  private deliverer: ReportDeliverer | null = null;
  private busy = false;
  private stats: ReporterStats = { accepted: 0, coalesced: 0, droppedByCap: 0, invalid: 0 };

  constructor(opts: ReporterOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.isDev = opts.isDev ?? (() => typeof __DEV__ !== "undefined" && __DEV__ === true);
    this.buildInfo = opts.buildInfo ?? getBuildInfo;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxObserved = opts.maxObserved ?? 50;
    this.maxTrackedKeys = opts.maxTrackedKeys ?? 100;
    this.maxPerWindow = opts.maxReportsPerWindow ?? 30;
  }

  /** Install (or remove with null) the future delivery function. Phase 3B installs none. */
  setDeliverer(fn: ReportDeliverer | null): void {
    this.deliverer = fn;
  }

  /** Normalizes arbitrary input into a sanitized report. Exposed for tests; returns null if nothing usable. */
  build(input: TechnicalErrorInput): ClientTechnicalReport | null {
    const error = input?.error;
    const errorClass = sanitizeErrorClass(
      input?.errorClass ?? (error instanceof Error ? error.name : readProp(error, "name"))
    );
    const errorCode = sanitizeErrorCode(input?.errorCode ?? readProp(error, "code"));
    const message = sanitizeMessage(input?.message ?? error);
    const operation = sanitizeOperation(input?.operation);
    const context = sanitizeContext(input?.context);
    const b = this.buildInfo();
    const report: ClientTechnicalReport = {
      operation,
      errorClass,
      message,
      severity: sanitizeSeverity(input?.severity),
      context,
    };
    if (errorCode) report.errorCode = errorCode;
    if (b.appVersion) report.appVersion = b.appVersion;
    if (b.build) report.build = b.build;
    if (b.platform) report.platform = b.platform;
    if (b.env) report.env = b.env;
    return report;
  }

  /** Fire-and-forget. Never throws; the return value is intentionally void. */
  report(input: TechnicalErrorInput): void {
    if (this.busy) return; // re-entrant call from inside a delivery attempt: drop (no recursion)
    this.busy = true;
    try {
      const report = this.build(input);
      if (!report) {
        this.stats.invalid++;
        return;
      }
      const t = this.now();

      // global cap per window
      this.recent = this.recent.filter((x) => t - x < this.windowMs);
      const key = `${report.operation}|${report.errorClass}|${report.errorCode ?? ""}|${report.message}|${report.context.http_status ?? ""}`;
      const known = this.tracked.get(key);
      if (known && t - known.firstAt < this.windowMs) {
        this.stats.coalesced++;
        if (known.entry) {
          known.entry.count++;
          known.entry.lastAt = t;
        }
        return;
      }
      if (this.recent.length >= this.maxPerWindow) {
        this.stats.droppedByCap++;
        return;
      }
      this.recent.push(t);

      let entry: ObservedReport | undefined;
      if (this.isDev()) {
        entry = { report, count: 1, firstAt: t, lastAt: t };
        this.observed.push(entry);
        if (this.observed.length > this.maxObserved) this.observed.shift();
      }
      this.tracked.delete(key);
      this.tracked.set(key, { firstAt: t, entry });
      while (this.tracked.size > this.maxTrackedKeys) {
        const oldest = this.tracked.keys().next().value;
        if (oldest === undefined) break;
        this.tracked.delete(oldest);
      }
      this.stats.accepted++;

      const deliver = this.deliverer;
      if (deliver) {
        try {
          const r = deliver(toWirePayload(report));
          if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, () => undefined);
        } catch {
          /* delivery failures are never reported and never propagate */
        }
      }
    } catch {
      this.stats.invalid++;
    } finally {
      this.busy = false;
    }
  }

  getObserved(): ObservedReport[] {
    return this.observed.map((o) => ({ ...o, report: { ...o.report, context: { ...o.report.context } } }));
  }

  clearObserved(): void {
    this.observed = [];
  }

  getStats(): ReporterStats {
    return { ...this.stats };
  }

  /** Test helper: forget everything (observations, coalescing state, stats, deliverer). */
  reset(): void {
    this.observed = [];
    this.tracked.clear();
    this.recent = [];
    this.deliverer = null;
    this.busy = false;
    this.stats = { accepted: 0, coalesced: 0, droppedByCap: 0, invalid: 0 };
  }
}

/** The app-wide reporter. */
export const technicalReporter = new TechnicalReporter();

/** Fire-and-forget convenience wrapper around the app-wide reporter. Never throws. */
export function reportTechnicalError(input: TechnicalErrorInput): void {
  try {
    technicalReporter.report(input);
  } catch {
    /* never propagate */
  }
}
