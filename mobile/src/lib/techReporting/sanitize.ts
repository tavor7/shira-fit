/**
 * Minimal client-side sanitization (defense in depth). The SERVER remains authoritative for redaction and
 * fingerprinting; this only avoids sending obviously sensitive or needlessly volatile material in the first place.
 * Deliberately small: a handful of anchored patterns, a strict allowlist for context, and hard length bounds.
 */
import type { ReportContext, ReportSeverity } from "./types";

export const MAX_MESSAGE_LENGTH = 200;
const MAX_INPUT_LENGTH = 2000;

const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  // credentials first, while the surrounding structure is intact
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <token>"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "<token>"],
  [/\b(password|passwd|pwd|token|access_token|refresh_token|secret|api_?key|apikey|authorization|cookie|set-cookie)\s*[=:]\s*[^\s,;&"']+/gi, "$1=<redacted>"],
  // urls (drops query strings, fragments and any dynamic path segments)
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "<url>"],
  // personal data shapes
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // volatile identifiers
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>"],
  [/\+?\d[\d\s().-]{6,}\d/g, "<n>"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "<token>"],
];

/** Coerces anything to a short, single-line, sanitized string. Never throws. */
export function sanitizeMessage(raw: unknown): string {
  let s: string;
  try {
    if (typeof raw === "string") s = raw;
    else if (raw instanceof Error) s = raw.message;
    else if (raw === null || raw === undefined) s = "";
    else if (typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string") s = (raw as { message: string }).message;
    else s = "";
  } catch {
    s = "";
  }
  try {
    // Bound the INPUT before any regex runs: a pathological multi-megabyte message must never cost quadratic time.
    if (s.length > MAX_INPUT_LENGTH) s = s.slice(0, MAX_INPUT_LENGTH);
    for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
    s = s.replace(/\s+/g, " ").trim();
  } catch {
    s = "";
  }
  return s.length > MAX_MESSAGE_LENGTH ? s.slice(0, MAX_MESSAGE_LENGTH) : s;
}

const CLASS_RE = /^[A-Za-z0-9_.$-]{1,80}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const NAME_RE = /^[a-z0-9_-]{1,64}$/;
const ENUM_RE = /^[a-z0-9_]{1,24}$/;
const OPERATION_RE = /^[a-z_]{2,16}\/[A-Za-z0-9_./:-]{1,100}$/;

export function sanitizeErrorClass(raw: unknown): string {
  return typeof raw === "string" && CLASS_RE.test(raw) ? raw : "Error";
}

export function sanitizeErrorCode(raw: unknown): string | undefined {
  return typeof raw === "string" && CODE_RE.test(raw) ? raw : undefined;
}

/** Operation names keep a stable shape and never carry volatile identifiers. */
export function sanitizeOperation(raw: unknown): string {
  if (typeof raw !== "string") return "transport/unspecified";
  const s = raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/[0-9]{7,}/g, ":n")
    .slice(0, 120);
  return OPERATION_RE.test(s) ? s : "transport/unspecified";
}

/** A route/table/function identifier: lower snake case only, otherwise `undefined` (dropped). */
export function safeName(raw: unknown): string | undefined {
  return typeof raw === "string" && NAME_RE.test(raw) ? raw : undefined;
}

export function sanitizeSeverity(raw: unknown): ReportSeverity {
  return raw === "info" || raw === "warning" || raw === "error" ? raw : "error";
}

function safeInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && Math.abs(raw) <= 2147483647 ? Math.trunc(raw) : undefined;
}

/**
 * Strict allowlist with per-key type validation. Anything else (ids, headers, bodies, free text, unknown keys) is dropped.
 * The allowlist is the same set the server accepts for client context by default; it is intentionally NOT configurable here.
 */
export function sanitizeContext(raw: unknown): ReportContext {
  const out: ReportContext = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const http = safeInt(o.http_status);
  if (http !== undefined && http >= 100 && http <= 599) out.http_status = http;
  const rpc = safeName(o.rpc);
  if (rpc) out.rpc = rpc;
  const table = safeName(o.table);
  if (table) out.table = table;
  const edge = safeName(o.edge_function);
  if (edge) out.edge_function = edge;
  if (typeof o.network_state === "string" && ENUM_RE.test(o.network_state)) out.network_state = o.network_state;
  if (typeof o.phase === "string" && ENUM_RE.test(o.phase)) out.phase = o.phase;
  if (typeof o.retryable === "boolean") out.retryable = o.retryable;
  const attempt = safeInt(o.attempt);
  if (attempt !== undefined && attempt >= 0 && attempt <= 1000) out.attempt = attempt;
  const dur = safeInt(o.duration_ms);
  if (dur !== undefined && dur >= 0) out.duration_ms = dur;
  return out;
}
