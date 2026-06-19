import { supabase } from "./supabase";

export type MoveParticipantParams = {
  fromSessionId: string;
  toSessionId: string;
  userId?: string;
  manualParticipantId?: string;
  allowOverCapacity?: boolean;
  decreaseSourceMax?: boolean;
  increaseDestMax?: boolean;
};

export type MoveParticipantResult =
  | { ok: true }
  | { ok: false; error: string };

export async function staffMoveSessionParticipant(params: MoveParticipantParams): Promise<MoveParticipantResult> {
  const { data, error } = await supabase.rpc("staff_move_session_participant", {
    p_from_session_id: params.fromSessionId,
    p_to_session_id: params.toSessionId,
    p_user_id: params.userId ?? null,
    p_manual_participant_id: params.manualParticipantId ?? null,
    p_allow_over_capacity: params.allowOverCapacity ?? false,
    p_decrease_source_max: params.decreaseSourceMax ?? false,
    p_increase_dest_max: params.increaseDestMax ?? false,
  });
  if (error) return { ok: false, error: error.message };
  if (data?.ok === true) return { ok: true };
  return { ok: false, error: String(data?.error ?? "failed") };
}
