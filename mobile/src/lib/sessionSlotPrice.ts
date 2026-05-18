import type { SupabaseClient } from "@supabase/supabase-js";

/** Parse custom session rate draft; empty string clears override. */
export function parseCustomSlotPriceDraft(
  draft: string
): { ok: true; price: number | null } | { ok: false } {
  const trimmed = draft.trim();
  if (trimmed === "") return { ok: true, price: null };
  const n = parseFloat(trimmed.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, price: n };
}

/**
 * Client-side mirror of DB `session_billing_price_ils` when RPC is unavailable.
 * Order: session custom → athlete tier override → global tier.
 */
export function resolveSessionBillingPriceLocal(args: {
  customSlotPriceIls: number | null | undefined;
  maxParticipants: number;
  isKickbox?: boolean;
  athletePriceByCap: Record<number, number>;
  globalPriceByCap: Record<number, number>;
  globalKickboxPriceByCap?: Record<number, number>;
}): number | null {
  const custom = args.customSlotPriceIls;
  if (custom != null && Number.isFinite(Number(custom))) return Number(custom);
  const cap = args.maxParticipants;
  if (!Number.isFinite(cap) || cap < 1) return null;
  if (args.isKickbox) {
    const kick = args.globalKickboxPriceByCap?.[cap];
    if (kick != null && Number.isFinite(kick)) return kick;
    const fallback = args.globalPriceByCap[cap];
    if (fallback != null && Number.isFinite(fallback)) return fallback;
    return null;
  }
  const athlete = args.athletePriceByCap[cap];
  if (athlete != null && Number.isFinite(athlete)) return athlete;
  const tier = args.globalPriceByCap[cap];
  if (tier != null && Number.isFinite(tier)) return tier;
  return null;
}

/** DB `session_billing_price_ils` — authoritative hierarchy. */
export async function fetchSessionBillingPriceIls(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string | null
): Promise<number> {
  const { data, error } = await supabase.rpc("session_billing_price_ils", {
    p_session_id: sessionId,
    p_user_id: userId,
  });
  if (error) return 0;
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

export async function sumSessionBillingPrices(
  supabase: SupabaseClient,
  sessionId: string,
  userIds: (string | null)[]
): Promise<number> {
  let total = 0;
  for (const uid of userIds) {
    // eslint-disable-next-line no-await-in-loop
    total += await fetchSessionBillingPriceIls(supabase, sessionId, uid);
  }
  return total;
}
