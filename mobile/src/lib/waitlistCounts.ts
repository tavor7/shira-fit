import { supabase } from "./supabase";

/** Waitlist counts per session (batch). Staff-only on the server side. */
export async function fetchWaitlistCountsBySession(sessionIds: string[]): Promise<Record<string, number>> {
  if (sessionIds.length === 0) return {};
  const { data, error } = await supabase.rpc("waitlist_counts", {
    p_session_ids: sessionIds,
  });
  if (error || !data) return {};
  const out: Record<string, number> = {};
  for (const row of data as unknown as { session_id: string; n: number }[]) {
    out[String(row.session_id)] = Number(row.n ?? 0);
  }
  return out;
}

