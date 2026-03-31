import { supabase } from "./supabase";

/** Active registration counts per session (batch). */
export async function fetchActiveSignupCountsBySession(sessionIds: string[]): Promise<Record<string, number>> {
  if (sessionIds.length === 0) return {};
  const { data } = await supabase
    .from("session_registrations")
    .select("session_id")
    .in("session_id", sessionIds)
    .eq("status", "active");
  const m: Record<string, number> = {};
  for (const row of data ?? []) {
    const id = (row as { session_id: string }).session_id;
    m[id] = (m[id] ?? 0) + 1;
  }
  return m;
}
