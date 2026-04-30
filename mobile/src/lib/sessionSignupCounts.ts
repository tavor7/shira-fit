import { supabase } from "./supabase";

/** Active registration counts per session (batch). */
export async function fetchActiveSignupCountsBySession(sessionIds: string[]): Promise<Record<string, number>> {
  if (sessionIds.length === 0) return {};
  const { data, error } = await supabase.rpc("active_registration_counts", {
    p_session_ids: sessionIds,
  });
  if (error || !data) return {};
  const out: Record<string, number> = {};
  for (const row of data as unknown as { session_id: string; n: number }[]) {
    out[String(row.session_id)] = Number(row.n ?? 0);
  }
  return out;
}
