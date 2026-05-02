import { supabase } from "./supabase";

/**
 * Re-register athletes and manual links from `sourceSessionId` onto `targetSessionId`
 * (after the target session row exists). Returns human-readable errors; empty = full success.
 */
export async function copySessionParticipantsToNewSession(
  sourceSessionId: string,
  targetSessionId: string
): Promise<string[]> {
  const errors: string[] = [];

  const { data: regs, error: regErr } = await supabase
    .from("session_registrations")
    .select("user_id")
    .eq("session_id", sourceSessionId)
    .eq("status", "active");

  if (regErr) {
    errors.push(regErr.message);
    return errors;
  }

  for (const row of regs ?? []) {
    const user_id = String((row as { user_id: string }).user_id ?? "").trim();
    if (!user_id) continue;
    const { data, error } = await supabase.rpc("coach_add_athlete", {
      p_session_id: targetSessionId,
      p_user_id: user_id,
    });
    if (error) errors.push(`${user_id}: ${error.message}`);
    else if (!data?.ok) errors.push(`${user_id}: ${String((data as { error?: string })?.error ?? "failed")}`);
  }

  const { data: manuals, error: manErr } = await supabase
    .from("session_manual_participants")
    .select("manual_participant_id")
    .eq("session_id", sourceSessionId);

  if (manErr) {
    errors.push(manErr.message);
    return errors;
  }

  for (const row of manuals ?? []) {
    const manual_participant_id = String((row as { manual_participant_id: string }).manual_participant_id ?? "").trim();
    if (!manual_participant_id) continue;
    const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
      p_session_id: targetSessionId,
      p_manual_participant_id: manual_participant_id,
    });
    if (error) errors.push(`manual ${manual_participant_id}: ${error.message}`);
    else if (!data?.ok)
      errors.push(`manual ${manual_participant_id}: ${String((data as { error?: string })?.error ?? "failed")}`);
  }

  return errors;
}
