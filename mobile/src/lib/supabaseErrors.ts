import type { PostgrestError } from "@supabase/supabase-js";

/** Thrown when a Supabase query/RPC returns a non-null error, instead of silently falling back. */
export class SupabaseQueryError extends Error {
  readonly context: string;
  readonly cause: PostgrestError;

  constructor(context: string, cause: PostgrestError) {
    super(`${context}: ${cause.message}`);
    this.name = "SupabaseQueryError";
    this.context = context;
    this.cause = cause;
  }
}

/**
 * Unwrap a Supabase `{ data, error }` result (from `.from()` or `.rpc()`).
 * Throws `SupabaseQueryError` on a real error; a legitimately empty `data`
 * (e.g. `.maybeSingle()` finding no row) is NOT an error and passes through.
 */
export function unwrap<T>(
  result: { data: T; error: PostgrestError | null },
  context: string
): T {
  if (result.error) throw new SupabaseQueryError(context, result.error);
  return result.data;
}
