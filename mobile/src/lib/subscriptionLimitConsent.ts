/**
 * Generic "attempt an action, detect the backend's structured subscription_limit_exceeded
 * rejection, and expose a retry-with-consent path" orchestration.
 *
 * Several RPCs (register_for_session, coach_add_athlete, add_manual_participant_to_session,
 * staff_move_session_participant, manager_revert_activity_event) share the exact same contract:
 * a first attempt without consent can come back `{ ok: false, error: "subscription_limit_exceeded",
 * reason?: "frozen" | "tier_not_included" | "allowance_exceeded" }`, and the caller must show an
 * explicit confirmation before retrying with `p_accept_extra_subscription_charge: true`. This
 * module is the single place that shape is understood client-side — every call site (athlete
 * self-registration, the coach/manager add-participant modal) wraps its own RPC call with this
 * same helper instead of re-implementing the detect-then-retry dance.
 */

export type SubscriptionLimitReason = "frozen" | "tier_not_included" | "allowance_exceeded" | string | undefined;

export type RpcOkResult = { ok: true } & Record<string, unknown>;
export type RpcFailResult = { ok: false; error?: string; reason?: string } & Record<string, unknown>;
export type RpcResult = RpcOkResult | RpcFailResult;

/** True iff this response is the structured subscription-limit rejection that requires explicit
 * consent before it can be retried as a paid/extra registration -- never inferred, only ever read
 * directly off what the backend actually returned. */
export function isSubscriptionLimitExceeded(
  data: RpcResult | null | undefined
): data is RpcFailResult & { error: "subscription_limit_exceeded" } {
  return !!data && data.ok === false && data.error === "subscription_limit_exceeded";
}

export type ConsentOutcome<T extends RpcResult> = T | { ok: false; error: "cancelled" };

/**
 * Calls `callRpc(false)`. If it succeeds, or fails for any reason OTHER than
 * subscription_limit_exceeded, that result is returned as-is (untouched, not this special flow).
 * If it fails specifically with subscription_limit_exceeded, `confirmConsent` is awaited with the
 * backend-provided reason; declining resolves to `{ ok: false, error: "cancelled" }` (no retry, no
 * state change); confirming retries `callRpc(true)` exactly once and returns whatever that call
 * returns (success or failure, including a second subscription_limit_exceeded if the backend still
 * refuses -- this function never loops or retries more than once).
 */
export async function attemptWithSubscriptionConsent<T extends RpcResult>(
  callRpc: (acceptExtraSubscriptionCharge: boolean) => Promise<T>,
  confirmConsent: (reason: SubscriptionLimitReason) => Promise<boolean>
): Promise<ConsentOutcome<T>> {
  const first = await callRpc(false);
  if (first.ok) return first;
  if (!isSubscriptionLimitExceeded(first)) return first;
  const proceed = await confirmConsent(first.reason);
  if (!proceed) return { ok: false, error: "cancelled" };
  return callRpc(true);
}
