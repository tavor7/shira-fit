import { supabase } from "./supabase";

/** Best-effort client-side audit events (auth flows). Never throws. */
export async function logUserActivity(
  eventType: string,
  opts?: { targetType?: string | null; targetId?: string | null; metadata?: Record<string, unknown> }
) {
  try {
    const { error } = await supabase.rpc("log_user_activity", {
      p_event_type: eventType,
      p_target_type: opts?.targetType ?? null,
      p_target_id: opts?.targetId ?? null,
      p_metadata: (opts?.metadata ?? {}) as object,
    });
    if (error) console.warn("log_user_activity", error.message);
  } catch (e) {
    console.warn("log_user_activity", e);
  }
}
