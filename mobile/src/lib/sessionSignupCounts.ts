import { supabase } from "./supabase";

async function fetchCountsViaRpc(rpcName: string, sessionIds: string[]): Promise<Record<string, number>> {
  if (sessionIds.length === 0) return {};
  const { data, error } = await supabase.rpc(rpcName, { p_session_ids: sessionIds });
  if (error || !data) return {};
  const out: Record<string, number> = {};
  for (const row of data as unknown as { session_id: string; n: number }[]) {
    out[String(row.session_id)] = Number(row.n ?? 0);
  }
  return out;
}

/**
 * Real active registration counts per session (batch) — unaffected by Super
 * User hiding. Use for anything capacity-related: registration/waitlist
 * limits, athlete "spots left", move-participant checks. A hidden athlete
 * still occupies a real seat.
 */
export async function fetchActiveSignupCountsBySession(sessionIds: string[]): Promise<Record<string, number>> {
  return fetchCountsViaRpc("active_registration_counts", sessionIds);
}

/**
 * Role-aware registration counts for staff calendar-card display: excludes
 * athletes hidden from the calling coach/manager's own view, so the number
 * shown matches what that viewer can actually see in the roster. The Super
 * User always gets the real count. Do not use this for capacity/limit
 * decisions — use fetchActiveSignupCountsBySession for that.
 */
export async function fetchVisibleSignupCountsBySession(sessionIds: string[]): Promise<Record<string, number>> {
  return fetchCountsViaRpc("visible_registration_counts", sessionIds);
}
