/**
 * Client technical reporting types (monitoring Phase 3B). Nothing here talks to the network.
 *
 * The shape deliberately mirrors the fields of the Phase 1 untrusted-client ingestion contract
 * (report_client_error): the SERVER decides source, subsystem, severity ceiling, fingerprint and final
 * redaction; the client only supplies a bounded, pre-sanitized description of what failed.
 */

export type ReportSeverity = "info" | "warning" | "error";

/** Allowlisted, typed context. Mirrors the server's default `context` allowlist (the keys that make sense client-side). */
export interface ReportContext {
  http_status?: number;
  rpc?: string;
  table?: string;
  edge_function?: string;
  network_state?: string;
  phase?: string;
  retryable?: boolean;
  attempt?: number;
  duration_ms?: number;
}

/** What a caller hands to the reporter. Everything is optional and untrusted; the reporter normalizes it. */
export interface TechnicalErrorInput {
  /** `<family>/<name>`, e.g. `transport/rpc:register_for_session`. */
  operation?: string;
  /** Anything that was thrown/returned. Never forwarded as-is: only a sanitized name/code/message is derived. */
  error?: unknown;
  errorClass?: string;
  errorCode?: string;
  message?: string;
  severity?: ReportSeverity;
  /** Raw context; only allowlisted, correctly typed keys survive. */
  context?: Record<string, unknown>;
}

/** A normalized, sanitized report (what WOULD be sent). snake_case wire names are produced by `toWirePayload`. */
export interface ClientTechnicalReport {
  operation: string;
  errorClass: string;
  errorCode?: string;
  message: string;
  severity: ReportSeverity;
  context: ReportContext;
  appVersion?: string;
  build?: string;
  platform?: "ios" | "android" | "web";
  env?: string;
}

/** The JSON object report_client_error(jsonb) accepts for an untrusted client. */
export interface ReportWirePayload {
  operation: string;
  error_class: string;
  error_code?: string;
  message: string;
  severity: ReportSeverity;
  context: ReportContext;
  app_version?: string;
  build?: string;
  platform?: string;
  env?: string;
}

/** One observation-sink entry (development/test only). */
export interface ObservedReport {
  report: ClientTechnicalReport;
  /** Times the same report was seen inside the coalescing window (first one included). */
  count: number;
  firstAt: number;
  lastAt: number;
}

export type ReportDeliverer = (payload: ReportWirePayload) => Promise<unknown> | void;
