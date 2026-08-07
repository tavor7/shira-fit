import { supabase } from "./supabase";

/** Notify all actively-registered participants that a session's details changed. */
export async function notifySessionParticipantsUpdated(
  sessionId: string
): Promise<{ ok: boolean; notified?: number; error?: string }> {
  const { data, error } = await supabase.rpc("notify_session_participants_updated", {
    p_session_id: sessionId,
  });
  if (error) return { ok: false, error: error.message };
  const raw = data as Record<string, unknown> | null;
  if (!raw?.ok) return { ok: false, error: String(raw?.error ?? "failed") };
  return { ok: true, notified: Number(raw.notified ?? 0) };
}
