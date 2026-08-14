import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "./supabaseErrors";

/** Parse custom coach rate draft; empty string clears the override. */
export function parseCustomCoachRateDraft(
  draft: string
): { ok: true; rate: number | null } | { ok: false } {
  const trimmed = draft.trim();
  if (trimmed === "") return { ok: true, rate: null };
  const n = parseFloat(trimmed.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, rate: n };
}

/** DB `coach_capacity_price_ils` — flat payout for a coach at the given registered headcount. */
export async function fetchCoachCapacityRateIls(
  supabase: SupabaseClient,
  coachId: string,
  registeredCount: number,
  asOf: string
): Promise<number | null> {
  if (!coachId || registeredCount <= 0) return null;
  const result = await supabase.rpc("coach_capacity_price_ils", {
    p_coach_id: coachId,
    p_registered_tier: registeredCount,
    p_as_of: asOf,
  });
  const data = unwrap(result, "fetchCoachCapacityRateIls");
  const n = Number(data);
  return Number.isFinite(n) && n > 0 ? n : null;
}
