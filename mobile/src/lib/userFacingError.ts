import { isLikelyNetworkError } from "./networkErrors";

/**
 * Boundary between technical failures and what users read.
 *
 * Screens must not show raw error text ("TypeError: Failed to fetch", "Cannot coerce the result to a
 * single JSON object", backend codes). They show the localized message for the failure's kind instead.
 * The technical detail is not lost: transport failures are captured by lib/techReporting, and callers
 * can still log the original error. Business-rule messages that are already localized (e.g. registration
 * outcomes from lib/rpcOutcomes) are not routed through here.
 */
export type UserErrorKind = "network" | "notFound" | "permission" | "session" | "unknown";

type ErrorLike = { message?: unknown; code?: unknown; status?: unknown; cause?: unknown };

function fields(err: unknown): { message: string; code: string; status: number | null } {
  if (err == null) return { message: "", code: "", status: null };
  if (typeof err === "string") return { message: err, code: "", status: null };
  const e = err as ErrorLike;
  const cause = (e.cause && typeof e.cause === "object" ? e.cause : {}) as ErrorLike;
  const message = [e.message, cause.message].filter((m) => typeof m === "string").join(" ");
  const code = String(e.code ?? cause.code ?? "");
  const rawStatus = e.status ?? cause.status;
  return { message, code, status: typeof rawStatus === "number" ? rawStatus : null };
}

export function classifyUserError(err: unknown): UserErrorKind {
  const { message, code, status } = fields(err);
  // Loose network wording is trusted only on real Error objects; plain text needs an unmistakable fetch failure.
  const strictNetwork = /failed to fetch|fetch failed|load failed|network request failed|networkerror|ECONNREFUSED|ETIMEDOUT/i.test(message);
  if (strictNetwork || (err instanceof Error && isLikelyNetworkError(err)) || status === 0) return "network";
  if (code === "PGRST116" || /cannot coerce the result to a single json object|json object requested, multiple \(or no\) rows/i.test(message) || status === 404 || status === 406) {
    return "notFound";
  }
  if (/jwt expired|invalid refresh token|refresh token not found|auth session missing/i.test(message) || status === 401) return "session";
  if (code === "42501" || /permission denied|not authorized|forbidden|row-level security/i.test(message) || status === 403) return "permission";
  return "unknown";
}

/** Message of a database business-rule exception (RAISE EXCEPTION, SQLSTATE P0001): written for people, kept as-is. */
function businessMessage(err: unknown): string | null {
  const e = (err ?? {}) as ErrorLike;
  const cause = (e.cause && typeof e.cause === "object" ? e.cause : {}) as ErrorLike;
  if (String(cause.code ?? "") === "P0001" && typeof cause.message === "string") return cause.message;
  if (String(e.code ?? "") === "P0001" && typeof e.message === "string") return e.message;
  return null;
}

export const USER_ERROR_KEYS: Record<UserErrorKind, string> = {
  network: "errors.network",
  notFound: "errors.notFound",
  permission: "errors.permission",
  session: "errors.session",
  unknown: "errors.generic",
};

/**
 * True for errors whose text is implementation detail: runtime errors, Postgres/PostgREST errors and
 * codes, SQL wording. Plain errors thrown by app code with a readable (usually already localized)
 * message are not technical.
 */
export function isTechnicalError(err: unknown): boolean {
  if (businessMessage(err)) return false;
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError || err instanceof RangeError) return true;
  const { message, code } = fields(err);
  if ((err as { name?: unknown })?.name === "SupabaseQueryError" || /^(PGRST\w+|2[23]\w{3}|42\w{3}|08\w{3}|53\w{3}|57\w{3}|XX\w{3})$/.test(code)) return true;
  return /violates|relation "|column "|function \w+\(|syntax error|json|pgrst|duplicate key|null value in column|cannot read propert|is not a function|unexpected token|undefined is not/i.test(message);
}

/**
 * Localized, actionable message for a failure (pass the screen's `t`). Known failure kinds map to their
 * message; other technical errors map to a generic one; a readable message thrown by app code is kept.
 */
export function userFacingErrorMessage(err: unknown, t: (key: string) => string): string {
  const kind = classifyUserError(err);
  if (kind !== "unknown") return t(USER_ERROR_KEYS[kind]);
  const business = businessMessage(err);
  if (business) return business;
  if (isTechnicalError(err)) return t(USER_ERROR_KEYS.unknown);
  const { message } = fields(err);
  return message.trim() ? message : t(USER_ERROR_KEYS.unknown);
}

/**
 * Last-line guard for text about to be shown in a toast or alert: technical error text (as produced by
 * `String(err)` / `err.message` further up) becomes the localized message for its kind; any other text,
 * including localized business messages, passes through unchanged.
 */
export function toUserFacingText(text: string | undefined, t: (key: string) => string): string | undefined {
  if (!text) return text;
  const kind = classifyUserError(text);
  if (kind !== "unknown") return t(USER_ERROR_KEYS[kind]);
  return isTechnicalError(text) ? t(USER_ERROR_KEYS.unknown) : text;
}
