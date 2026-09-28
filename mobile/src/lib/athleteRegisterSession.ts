import { supabase } from "./supabase";
import type { RpcResult } from "./subscriptionLimitConsent";

export type RegisterForSessionResult = RpcResult;

/** Thin wrapper around register_for_session, mirroring staffMoveSessionParticipant.ts's shape so
 * the same attemptWithSubscriptionConsent helper can drive both. */
export async function registerForSession(
  sessionId: string,
  acceptExtraSubscriptionCharge = false
): Promise<RegisterForSessionResult> {
  const { data, error } = await supabase.rpc("register_for_session", {
    p_session_id: sessionId,
    p_accept_extra_subscription_charge: acceptExtraSubscriptionCharge,
  });
  if (error) return { ok: false, error: error.message };
  if (data?.ok === true) return { ok: true, ...data };
  return { ok: false, error: String(data?.error ?? "failed"), reason: data?.reason ?? undefined };
}
