import { supabase } from "./supabase";

/**
 * Currently-hidden (session, athlete) lookups for the Super User's own UI.
 *
 * Safe to import anywhere: RLS on `super_user_hidden_registrations` already
 * restricts rows to the Super User account, so a non-super-user caller
 * always gets an empty result. Callers should still gate on
 * `profile?.is_super_user` before calling — both to avoid the wasted
 * request and so the underlying UI/state referencing "hidden" never exists
 * for anyone else.
 */

export function hiddenRegistrationKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

/** Set of session_ids that currently have at least one hidden athlete. */
export async function fetchSessionIdsWithHiddenAthletes(sessionIds?: string[]): Promise<Set<string>> {
  let query = supabase
    .from("super_user_hidden_registrations")
    .select("session_id")
    .is("unhidden_at", null);
  if (sessionIds && sessionIds.length > 0) {
    query = query.in("session_id", sessionIds);
  }
  const { data, error } = await query;
  if (error || !data) return new Set();
  return new Set((data as { session_id: string }[]).map((r) => r.session_id));
}

/** Set of "sessionId:userId" keys currently hidden. */
export async function fetchHiddenRegistrationKeys(sessionIds?: string[]): Promise<Set<string>> {
  let query = supabase
    .from("super_user_hidden_registrations")
    .select("session_id, user_id")
    .is("unhidden_at", null);
  if (sessionIds && sessionIds.length > 0) {
    query = query.in("session_id", sessionIds);
  }
  const { data, error } = await query;
  if (error || !data) return new Set();
  return new Set(
    (data as { session_id: string; user_id: string }[]).map((r) => hiddenRegistrationKey(r.session_id, r.user_id))
  );
}
