/**
 * Reporting ELIGIBILITY and PAYLOAD MAPPING (monitoring Phase 3E.3). Pure: no network, no state, no logging, never throws.
 *
 * A failure is reported only if BOTH hold:
 *   1. the Phase 3A-3D classifier already says it is a reviewed TECHNICAL failure (registry / structured code), and
 *   2. its exact (operation, error_class, error_code) tuple is in the server allowlist table (allowlist.ts).
 * Raw error messages never take part in eligibility; business, authorization/validation, uncertain and unknown outcomes, arbitrary
 * SQLSTATE values, arbitrary HTTP 4xx, 408/429, network failures, aborts and the reporting RPC itself are never eligible.
 *
 * The payload contains only fields the server validator (_system_client_payload_valid) accepts, with fixed, non-sensitive text.
 */
import type { OutcomeClass } from "../rpcOutcomes/types";
import { isAllowlisted } from "./allowlist";

export type OutcomeCandidate =
  | { kind: "rpc_result"; operation: string; code: string; cls: OutcomeClass }
  | { kind: "rpc_reason"; operation: string; code: string; cls: OutcomeClass }
  | { kind: "postgrest"; operation: string; code: string; cls: OutcomeClass; raised: boolean };

export interface TransportCandidate {
  family: string;
  name?: string;
  status: number;
}

export interface WireContext {
  phase: string;
  rpc?: string;
  table?: string;
  edge_function?: string;
  sqlstate?: string;
  http_status?: number;
  retryable?: boolean;
}

export interface WirePayload {
  operation: string;
  error_class: string;
  error_code: string;
  message: string;
  severity: "warning";
  context: WireContext;
  app_version?: string;
  build?: string;
  platform?: "ios" | "android" | "web";
  env?: string;
}

/** Operations that must never be reported (recursion protection), by name. */
const NEVER = new Set(["report_client_error", "system_report_trusted"]);
const RPC_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const SQLSTATE_OR_PGRST_RE = /^([0-9A-Z]{5}|PGRST[0-9]{3})$/;
const TRANSPORT_NAME_RE = /^[a-z0-9_-]{1,64}$/;

/** Fixed message per class (the server stores its own rule title anyway; nothing derived from an error is ever sent). */
export const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  RpcOutcome: "RPC returned a technical failure outcome",
  RpcReason: "RPC reported an unexpected internal state",
  PostgrestError: "RPC failed with a database error",
  HttpError: "Server responded with an unavailable or error status",
};

type Draft = Omit<WirePayload, "app_version" | "build" | "platform" | "env">;

function rpcDraft(klass: "RpcOutcome" | "RpcReason", operation: string, code: string, phase: string): Draft | null {
  if (!RPC_NAME_RE.test(operation) || NEVER.has(operation) || !CODE_RE.test(code)) return null;
  const op = `rpc/${operation}`;
  if (!isAllowlisted(op, klass, code)) return null;
  return { operation: op, error_class: klass, error_code: code, message: FIXED_MESSAGES[klass], severity: "warning", context: { phase, rpc: operation } };
}

/** Maps an RPC outcome candidate to a payload draft, or null when it is not eligible. */
export function mapOutcome(c: OutcomeCandidate): Draft | null {
  try {
    if (c.cls !== "technical") return null;
    if (c.kind === "rpc_result") return rpcDraft("RpcOutcome", c.operation, c.code, "rpc_result");
    if (c.kind === "rpc_reason") return rpcDraft("RpcReason", c.operation, c.code, "rpc_reason");
    if (c.raised) return rpcDraft("RpcOutcome", c.operation, c.code, "rpc_error"); // P0001: the registry token
    // structured database / PostgREST code: the server operation is the fixed family `rpc/postgrest`
    if (!RPC_NAME_RE.test(c.operation) || NEVER.has(c.operation) || !SQLSTATE_OR_PGRST_RE.test(c.code)) return null;
    if (!isAllowlisted("rpc/postgrest", "PostgrestError", c.code)) return null;
    return {
      operation: "rpc/postgrest",
      error_class: "PostgrestError",
      error_code: c.code,
      message: FIXED_MESSAGES.PostgrestError,
      severity: "warning",
      context: { phase: "rpc_error", rpc: c.operation, sqlstate: c.code },
    };
  } catch {
    return null;
  }
}

/** Maps a transport failure to a payload draft. Only HTTP 500/502/503/504 are approved. */
export function mapTransport(t: TransportCandidate): Draft | null {
  try {
    const s = t.status;
    if (!Number.isInteger(s)) return null;
    const infra = s === 502 || s === 503 || s === 504;
    if (!infra && s !== 500) return null;
    const op = infra ? "transport/infra" : "transport/server";
    const code = `http_${s}`;
    if (!isAllowlisted(op, "HttpError", code)) return null;
    const context: WireContext = { phase: "transport", http_status: s, retryable: infra };
    const name = t.name && TRANSPORT_NAME_RE.test(t.name) ? t.name : undefined;
    if (name && t.family === "rpc") context.rpc = name;
    else if (name && t.family === "rest") context.table = name;
    else if (name && (t.family === "edge" || t.family === "functions")) context.edge_function = name;
    if (name && t.family === "rpc" && NEVER.has(name)) return null;
    return { operation: op, error_class: "HttpError", error_code: code, message: FIXED_MESSAGES.HttpError, severity: "warning", context };
  } catch {
    return null;
  }
}

/**
 * Converts the Phase 3B transport reporter's input (`operation: "transport/<family>[:name]"`, `errorCode: "http_<n>"`,
 * `context.http_status`) to a transport candidate. Anything else (network errors, 408/429, malformed) is not a candidate.
 */
export function transportCandidateFrom(input: unknown): TransportCandidate | null {
  try {
    const i = input as { operation?: unknown; errorClass?: unknown; errorCode?: unknown; context?: { http_status?: unknown } } | null;
    if (!i || i.errorClass !== "HttpError" || typeof i.operation !== "string" || typeof i.errorCode !== "string") return null;
    const m = /^transport\/([a-z]+)(?::([a-z0-9_-]{1,64}))?$/.exec(i.operation);
    if (!m) return null;
    const status = i.context?.http_status;
    if (typeof status !== "number" || i.errorCode !== `http_${status}`) return null;
    return { family: m[1], name: m[2], status };
  } catch {
    return null;
  }
}

/** The server's own validator, mirrored: a payload that would be rejected is never sent. */
export function isValidWirePayload(p: unknown): boolean {
  try {
    if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
    const o = p as Record<string, unknown>;
    const keys = new Set(["operation", "error_class", "error_code", "message", "severity", "context", "app_version", "build", "platform", "env"]);
    for (const k of Object.keys(o)) if (!keys.has(k)) return false;
    const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
    if (!str(o.operation, /^[a-z_]{2,16}\/[A-Za-z0-9_./:-]{1,100}$/) || !str(o.error_class, /^[A-Za-z0-9_.$-]{1,80}$/) || !str(o.error_code, /^[A-Za-z0-9_.-]{1,40}$/)) return false;
    if ("message" in o && !(typeof o.message === "string" && o.message.length <= 300)) return false;
    if ("severity" in o && !str(o.severity, /^[a-z]{1,16}$/)) return false;
    if ("app_version" in o && !str(o.app_version, /^[A-Za-z0-9._+-]{1,32}$/)) return false;
    if ("build" in o && !str(o.build, /^[A-Za-z0-9._+-]{1,32}$/)) return false;
    if ("platform" in o && !str(o.platform, /^(ios|android|web)$/)) return false;
    if ("env" in o && !str(o.env, /^[a-z]{2,16}$/)) return false;
    if ("context" in o) {
      const c = o.context;
      if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
      const entries = Object.entries(c as Record<string, unknown>);
      if (entries.length > 16) return false;
      for (const [k, v] of entries) if (k.length > 40 || (typeof v === "object" && v !== null)) return false;
    }
    return isAllowlisted(o.operation as string, o.error_class as string, o.error_code as string);
  } catch {
    return false;
  }
}
