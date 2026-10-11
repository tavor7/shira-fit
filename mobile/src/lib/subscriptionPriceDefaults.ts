/**
 * Default monthly subscription prices by weekly GROUP-session quota (1-4), configured by managers
 * (public.subscription_group_price_defaults, manager-only RLS) and used only to pre-fill the price of a NEW subscription.
 *
 * Rules (kept here, pure and unit-tested, so the form stays predictable):
 *  - A suggestion exists only when the subscription includes group sessions only (every other tier is 0) with a weekly
 *    group quota of 1-4 AND a default is configured for that quota. Anything else (other tiers, quota 0 or > 4, no
 *    default) gets no suggestion - no price is ever invented.
 *  - The price field remembers where its value came from: "suggested" (filled from a default), "manual" (typed by the
 *    manager) or "empty". A suggested price follows quota changes; a manual price is never overwritten - the form shows
 *    the default next to it with a "Use default" action instead. Clearing the field hands control back to suggestions.
 * Billing never reads the defaults: the subscription stores its own monthly price at creation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUBSCRIPTION_TIERS, type WeeklyLimits } from "./subscriptions";

export const GROUP_PRICE_DEFAULT_QUOTAS = [1, 2, 3, 4] as const;
export type GroupPriceDefaultQuota = (typeof GROUP_PRICE_DEFAULT_QUOTAS)[number];
export type GroupPriceDefaults = Partial<Record<GroupPriceDefaultQuota, number>>;

export const MAX_DEFAULT_PRICE_ILS = 100000;

/** Weekly group quota when the subscription is group-only and the quota is 1-4; otherwise null. */
export function groupOnlyQuota(allowances: WeeklyLimits): GroupPriceDefaultQuota | null {
  const group = allowances.group ?? 0;
  const othersZero = SUBSCRIPTION_TIERS.every((tier) => tier === "group" || (allowances[tier] ?? 0) === 0);
  if (!othersZero) return null;
  return (GROUP_PRICE_DEFAULT_QUOTAS as readonly number[]).includes(group) ? (group as GroupPriceDefaultQuota) : null;
}

export type PriceSuggestion = { quota: GroupPriceDefaultQuota; price: number };

export function suggestedMonthlyPrice(allowances: WeeklyLimits, defaults: GroupPriceDefaults): PriceSuggestion | null {
  const quota = groupOnlyQuota(allowances);
  if (quota == null) return null;
  const price = defaults[quota];
  return price != null && Number.isFinite(price) && price >= 0 ? { quota, price } : null;
}

export type PriceSource = "empty" | "suggested" | "manual";
export type PriceFieldState = { text: string; source: PriceSource };

export function formatPriceInput(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

/** The price field after the suggestion changed (quota changed, or defaults loaded). Manual prices are kept. */
export function applySuggestion(state: PriceFieldState, suggestion: PriceSuggestion | null): PriceFieldState {
  if (state.source === "manual") return state;
  if (suggestion) return { text: formatPriceInput(suggestion.price), source: "suggested" };
  return { text: "", source: "empty" };
}

/** The price field after the manager typed into it. */
export function editPrice(text: string): PriceFieldState {
  return { text, source: text.trim() === "" ? "empty" : "manual" };
}

/** Parse a default-price input ("" = no default). Returns undefined for invalid input. */
export function parseDefaultPriceInput(raw: string): number | null | undefined {
  const s = raw.replace(",", ".").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_DEFAULT_PRICE_ILS ? n : undefined;
}

export async function fetchGroupPriceDefaults(supabase: SupabaseClient): Promise<GroupPriceDefaults> {
  const { data, error } = await supabase
    .from("subscription_group_price_defaults")
    .select("group_sessions_per_week, monthly_price_ils");
  if (error) throw error;
  const out: GroupPriceDefaults = {};
  for (const row of (data ?? []) as { group_sessions_per_week: number; monthly_price_ils: number | string }[]) {
    if ((GROUP_PRICE_DEFAULT_QUOTAS as readonly number[]).includes(row.group_sessions_per_week)) {
      out[row.group_sessions_per_week as GroupPriceDefaultQuota] = Number(row.monthly_price_ils);
    }
  }
  return out;
}

/** Upserts the set quotas and deletes the cleared ones (manager-only RLS enforces who may do this). */
export async function saveGroupPriceDefaults(
  supabase: SupabaseClient,
  values: Record<GroupPriceDefaultQuota, number | null>
): Promise<void> {
  const upserts = GROUP_PRICE_DEFAULT_QUOTAS.filter((q) => values[q] != null).map((q) => ({
    group_sessions_per_week: q,
    monthly_price_ils: values[q] as number,
  }));
  const cleared = GROUP_PRICE_DEFAULT_QUOTAS.filter((q) => values[q] == null);
  if (upserts.length > 0) {
    const { error } = await supabase.from("subscription_group_price_defaults").upsert(upserts, { onConflict: "group_sessions_per_week" });
    if (error) throw error;
  }
  if (cleared.length > 0) {
    const { error } = await supabase.from("subscription_group_price_defaults").delete().in("group_sessions_per_week", cleared);
    if (error) throw error;
  }
}
