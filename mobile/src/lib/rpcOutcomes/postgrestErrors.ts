/**
 * Structured classification of PostgREST ERROR results of RPC calls (monitoring Phase 3D). Classification only: nothing here
 * reports, logs or retains anything.
 *
 * An RPC that fails inside the database comes back as an HTTP 4xx whose supabase-js result carries
 * `error = { code, message, details, hint }`. `code` is either
 *   - a PostgreSQL SQLSTATE (5 chars): `P0001` is what `RAISE EXCEPTION 'token'` produces (the token is the message), every
 *     other SQLSTATE is a database-raised error (safeupdate/cardinality 21000, constraint 23xxx, privileges 42501, ...), or
 *   - a PostgREST code `PGRSTnnn` (request/schema-cache problems).
 *
 * Decision rules (deterministic, no text heuristics):
 *   1. `P0001`: the message is the application's own RAISE token. If it has the shape of a code it is looked up in the Phase 3A
 *      registry exactly like a returned `error` code (operation first, then relays, then global rules); anything else
 *      (raw database text) is `<non_code>` and stays unknown. The message is never classified by its wording.
 *   2. Any other code: an exact table entry, else a SQLSTATE class entry (first two characters), else unknown.
 *   3. Unknown stays unknown: visible for review, never reportable.
 *
 * Ownership (who may look at an error result at all) is decided by the observer from the HTTP status, see `ownsHttpStatus`.
 */
import { classifyRpcOutcome } from "./classify";
import type { Classification, RegisteredOutcomeClass } from "./types";

type Rule = readonly [RegisteredOutcomeClass, string];
const T: RegisteredOutcomeClass = "technical";
const V: RegisteredOutcomeClass = "authorization_validation";
const U: RegisteredOutcomeClass = "uncertain";

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const PGRST_RE = /^PGRST[0-9]{3}$/;
/** A RAISE token: lower snake case, starts with a letter. Stricter than a returned code (no punctuation), so ids/uuids/emails/text never qualify. */
export const RAISE_TOKEN_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const NON_CODE = "<non_code>";
export const NO_CODE = "<no_code>";

/** Exact codes. Evidence for each class is the PostgreSQL / PostgREST documentation of the code. */
export const EXACT_CODE_RULES: Readonly<Record<string, Rule>> = {
  // --- database-raised, technical
  "21000": [T, "cardinality_violation: includes the safeupdate rejection of a DELETE/UPDATE without WHERE (the 2026-10 subscription-impact incident) and a scalar subquery returning several rows. A code defect."],
  "40001": [T, "serialization_failure: a transaction conflict the application did not retry."],
  "40P01": [T, "deadlock_detected."],
  P0003: [T, "too_many_rows (SELECT ... INTO STRICT): a violated assumption in a function."],
  P0004: [T, "assert_failure."],
  // --- PostgREST, technical: the client built a request the server cannot serve, or the deployed schema does not match the app
  PGRST100: [T, "Invalid query-string parameters built by the client."],
  PGRST102: [T, "Invalid request body built by the client."],
  PGRST103: [T, "Invalid range built by the client."],
  PGRST106: [T, "Schema not exposed/accepted."],
  PGRST107: [T, "Invalid content type built by the client."],
  PGRST111: [T, "Invalid response header setting."],
  PGRST200: [T, "Relationship not found in the schema cache: the app and the deployed schema disagree."],
  PGRST201: [T, "Ambiguous relationship: the app and the deployed schema disagree."],
  PGRST202: [T, "Function not found in the schema cache: the app calls an RPC the deployed schema lacks (or with other arguments)."],
  PGRST203: [T, "Overloaded function cannot be chosen (the 2026-09 overload incident class)."],
  PGRST204: [T, "Column not found in the schema cache."],
  // --- PostgREST, expected authentication states
  PGRST301: [V, "JWT invalid or expired: an expired session, handled by the auth refresh path."],
  PGRST302: [V, "Anonymous access disabled / no Authorization header."],
  PGRST303: [V, "JWT claims validation failed."],
  // --- reviewed, undecided
  "42501": [U, "insufficient_privilege: an RLS/grant refusal. Normal for a role gate, but also what a regression of the client-EXECUTE revocations (SEC-1/SEC-2) looks like; the code alone cannot tell."],
  PGRST116: [U, "A .single()/.maybeSingle() style request matched 0 or several rows: a stale reference or a broken assumption."],
};

/** SQLSTATE classes (first two characters) for codes with no exact entry. */
export const CLASS_RULES: Readonly<Record<string, Rule>> = {
  "22": [U, "data_exception (invalid text representation, out of range, ...): bad input reached the database; user input or a client defect."],
  "23": [U, "integrity_constraint_violation (unique, foreign key, not null, check, exclusion): a double submit/race or a missing guard; the code alone cannot tell."],
  "42": [T, "syntax error or access rule violation other than 42501 (undefined function/table/column, ambiguous reference, wrong type): the deployed schema and the app disagree."],
  "53": [T, "insufficient_resources."],
  "54": [T, "program_limit_exceeded."],
  "55": [T, "object_not_in_prerequisite_state (includes lock_not_available)."],
  "57": [T, "operator_intervention (includes query_canceled by statement_timeout)."],
  "58": [T, "system_error."],
  XX: [T, "internal_error."],
};

function own(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Which HTTP statuses of an RPC ERROR result belong to the RPC outcome layer. The transport layer (Phase 3B) owns fetch
 * rejections (status 0), every 5xx and 408/429; it never reads bodies and defers every other 4xx. The two sets are disjoint and
 * together cover every status, so a failure is seen by exactly one layer. A missing/unusable status is owned by nobody here.
 */
export function ownsHttpStatus(status: unknown): boolean {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface PostgrestClassification extends Classification {
  /** True when `code` is the application's own RAISE token (SQLSTATE P0001), false for database/PostgREST codes. */
  readonly raised: boolean;
}

/**
 * Classify the `error` of a supabase-js RPC result. PURE and total: never throws, reads only `code` (and `message` for P0001),
 * and returns nothing but allowlisted code strings.
 */
export function classifyPostgrestError(operation: string, error: unknown): PostgrestClassification {
  let rawCode: unknown;
  let rawMessage: unknown;
  try {
    const e = error as { code?: unknown; message?: unknown } | null;
    rawCode = e?.code;
    rawMessage = e?.message;
  } catch {
    rawCode = undefined;
  }
  const unknown = (code: string): PostgrestClassification => ({ operation, code, class: "unknown", source: "none", raised: false });

  if (typeof rawCode !== "string" || rawCode === "") return unknown(NO_CODE);
  if (rawCode === "P0001") {
    const token = typeof rawMessage === "string" && RAISE_TOKEN_RE.test(rawMessage) ? rawMessage : NON_CODE;
    return { ...classifyRpcOutcome(operation, token), raised: true };
  }
  if (!SQLSTATE_RE.test(rawCode) && !PGRST_RE.test(rawCode)) return unknown(NON_CODE);
  const make = (rule: Rule): PostgrestClassification => ({ operation, code: rawCode as string, class: rule[0], source: "structured_code", rationale: rule[1], raised: false });
  if (own(EXACT_CODE_RULES, rawCode)) return make(EXACT_CODE_RULES[rawCode]);
  const cls = rawCode.slice(0, 2);
  if (SQLSTATE_RE.test(rawCode) && own(CLASS_RULES, cls)) return make(CLASS_RULES[cls]);
  return unknown(rawCode);
}

/**
 * Reviewed alternative OUTCOME shapes on SUCCESSFUL (HTTP 2xx) results whose negative outcome is not `{ok:false, error}`.
 * Each entry was reviewed against the SQL and its caller; there is deliberately no generic `reason`/`status`/`failed` handling:
 * a field name never makes a result an outcome, only an entry in this table does.
 *
 *   manager_activity_revert_info: `{ ok:true, can_revert:false, reason:'<code>' }` - the "this event cannot be reverted" answer.
 *       The caller shows the reason to the manager. Every reason is registered under the operation in the Phase 3A registry.
 *
 * NOT listed on purpose (partial failures, deferred to dedicated business-outcome monitoring, never classified here):
 *   create_documents_from_payments (`ok:true` + `failed_count`/`failed[]`), maintain_session_series_horizon (`ok:true` +
 *   `failed`), send_custom_push_notification / notify_session_participants_updated (`notified` counts).
 */
export interface ReasonShape {
  /** The result must have `ok === true` and `data[flagKey] === flagValue` for `reason` to be an outcome. */
  readonly flagKey: string;
  readonly flagValue: boolean;
  readonly codeKey: string;
}
export const REVIEWED_REASON_SHAPES: Readonly<Record<string, ReasonShape>> = {
  manager_activity_revert_info: { flagKey: "can_revert", flagValue: false, codeKey: "reason" },
};
