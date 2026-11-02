import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTierPriceForDate, type PricingRateTierRow } from "./pricingRates";
import { unwrap } from "./supabaseErrors";

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
 * Order: roster override → session custom → athlete tier override → global tier.
 */
export function resolveSessionBillingPriceLocal(args: {
  customSlotPriceIls: number | null | undefined;
  maxParticipants: number;
  isKickbox?: boolean;
  sessionDate?: string;
  athleteTiers?: PricingRateTierRow[];
  globalTiers?: PricingRateTierRow[];
  globalKickboxTiers?: PricingRateTierRow[];
  athletePriceByCap?: Record<number, number>;
  globalPriceByCap?: Record<number, number>;
  globalKickboxPriceByCap?: Record<number, number>;
}): number | null {
  const custom = args.customSlotPriceIls;
  if (custom != null && Number.isFinite(Number(custom))) return Number(custom);
  const cap = args.maxParticipants;
  if (!Number.isFinite(cap) || cap < 1) return null;
  const asOf = args.sessionDate;
  if (asOf) {
    if (args.isKickbox) {
      const kick =
        (args.globalKickboxTiers
          ? resolveTierPriceForDate(args.globalKickboxTiers, cap, asOf)
          : null) ?? args.globalKickboxPriceByCap?.[cap] ?? null;
      if (kick != null) return kick;
      const fallback =
        (args.globalTiers ? resolveTierPriceForDate(args.globalTiers, cap, asOf) : null) ??
        args.globalPriceByCap?.[cap] ??
        null;
      return fallback;
    }
    const athlete =
      (args.athleteTiers ? resolveTierPriceForDate(args.athleteTiers, cap, asOf) : null) ??
      args.athletePriceByCap?.[cap] ??
      null;
    if (athlete != null) return athlete;
    const tier =
      (args.globalTiers ? resolveTierPriceForDate(args.globalTiers, cap, asOf) : null) ??
      args.globalPriceByCap?.[cap] ??
      null;
    return tier;
  }
  if (args.isKickbox) {
    const kick = args.globalKickboxPriceByCap?.[cap];
    if (kick != null && Number.isFinite(kick)) return kick;
    const fallback = args.globalPriceByCap?.[cap];
    if (fallback != null && Number.isFinite(fallback)) return fallback;
    return null;
  }
  const athlete = args.athletePriceByCap?.[cap];
  if (athlete != null && Number.isFinite(athlete)) return athlete;
  const tier = args.globalPriceByCap?.[cap];
  if (tier != null && Number.isFinite(tier)) return tier;
  return null;
}

/** Active global tier price for a capacity on a given session date. */
export async function fetchActiveGlobalTierPrice(
  supabase: SupabaseClient,
  cap: number,
  opts: { isKickbox?: boolean; asOf: string }
): Promise<number | null> {
  const result = await supabase
    .from("session_capacity_pricing")
    .select("price_ils")
    .eq("max_participants", cap)
    .eq("is_kickbox", !!opts.isKickbox)
    .lte("effective_from", opts.asOf)
    .or(`effective_to.is.null,effective_to.gte.${opts.asOf}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  const data = unwrap(result, "fetchActiveGlobalTierPrice");
  if (!data) return null;
  const n = Number(data.price_ils);
  return Number.isFinite(n) ? n : null;
}

export type SessionBillingPayee = {
  userId: string | null;
  manualParticipantId?: string | null;
};

/** DB `session_billing_price_ils` — authoritative hierarchy. */
export async function fetchSessionBillingPriceIls(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string | null,
  manualParticipantId?: string | null
): Promise<number> {
  const result = await supabase.rpc("session_billing_price_ils", {
    p_session_id: sessionId,
    p_user_id: userId,
    p_manual_participant_id: manualParticipantId ?? null,
  });
  const data = unwrap(result, "fetchSessionBillingPriceIls");
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

/** Key of a roster row in the batch result: `u:<user id>` or `m:<manual participant id>`. */
export function billingPayeeKey(userId: string | null, manualParticipantId?: string | null): string {
  return userId ? `u:${userId}` : `m:${manualParticipantId ?? ""}`;
}

/**
 * DB `session_billing_prices_ils` - the same authoritative `session_billing_price_ils` value for many roster rows in one
 * request (Performance Phase 2). Returns null when the batch is unavailable (older database) or fails for any reason;
 * callers then use the per-row `fetchSessionBillingPriceIls`, exactly as before.
 */
export async function fetchSessionBillingPricesIls(
  supabase: SupabaseClient,
  sessionId: string,
  payees: SessionBillingPayee[]
): Promise<Map<string, number> | null> {
  const userIds = [...new Set(payees.map((p) => p.userId).filter((x): x is string => !!x))];
  const manualIds = [
    ...new Set(payees.filter((p) => !p.userId).map((p) => p.manualParticipantId).filter((x): x is string => !!x)),
  ];
  if (userIds.length === 0 && manualIds.length === 0) return new Map();
  try {
    const { data, error } = await supabase.rpc("session_billing_prices_ils", {
      p_session_id: sessionId,
      p_user_ids: userIds,
      p_manual_participant_ids: manualIds,
    });
    if (error || !Array.isArray(data)) return null;
    const out = new Map<string, number>();
    for (const row of data as { user_id: string | null; manual_participant_id: string | null; price_ils: unknown }[]) {
      const n = Number(row.price_ils);
      out.set(billingPayeeKey(row.user_id, row.manual_participant_id), Number.isFinite(n) ? n : 0);
    }
    // Every requested row must be answered; otherwise do not trust the batch.
    for (const id of userIds) if (!out.has(billingPayeeKey(id))) return null;
    for (const id of manualIds) if (!out.has(billingPayeeKey(null, id))) return null;
    return out;
  } catch {
    return null;
  }
}

type RowBillingMeta = {
  max_participants: number;
  is_kickbox: boolean;
  session_date: string;
  custom_slot_price_ils: number | null;
};

/**
 * Billing price for one roster row — RPC first, then session/tier fallback when RPC is 0 or unavailable.
 */
export async function resolveRowBillingPriceIls(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string | null,
  manualParticipantId: string | null,
  sessionMeta: RowBillingMeta,
  rosterOverrideIls?: number | null,
  /** This row's `session_billing_price_ils` value when already fetched in a batch; skips that request. */
  knownRpcPriceIls?: number
): Promise<number> {
  if (rosterOverrideIls != null && Number.isFinite(rosterOverrideIls)) {
    return rosterOverrideIls;
  }

  const rpcPrice =
    knownRpcPriceIls !== undefined
      ? knownRpcPriceIls
      : await fetchSessionBillingPriceIls(supabase, sessionId, userId, manualParticipantId);
  if (rpcPrice > 0) return rpcPrice;

  const sessionCustom = sessionMeta.custom_slot_price_ils;
  if (sessionCustom != null && Number.isFinite(sessionCustom) && sessionCustom > 0) {
    return sessionCustom;
  }

  const result = await supabase.rpc("participant_capacity_price_ils", {
    p_user_id: userId,
    p_manual_participant_id: manualParticipantId,
    p_max_participants: sessionMeta.max_participants,
    p_is_kickbox: sessionMeta.is_kickbox,
    p_as_of: sessionMeta.session_date,
  });
  const data = unwrap(result, "resolveRowBillingPriceIls:participant_capacity_price_ils");
  if (data != null) {
    const tier = Number(data);
    if (Number.isFinite(tier) && tier > 0) return tier;
  }

  return 0;
}

export async function sumSessionBillingPrices(
  supabase: SupabaseClient,
  sessionId: string,
  payees: SessionBillingPayee[]
): Promise<number> {
  let total = 0;
  for (const payee of payees) {
    // eslint-disable-next-line no-await-in-loop
    total += await fetchSessionBillingPriceIls(
      supabase,
      sessionId,
      payee.userId,
      payee.manualParticipantId
    );
  }
  return total;
}
