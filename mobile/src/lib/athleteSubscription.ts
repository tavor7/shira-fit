/**
 * Athlete-facing "My Subscription" read model.
 *
 * Thin wrapper around the get_my_subscription() RPC (athlete-safe self-read, scoped via
 * auth.uid() server-side -- see 20260928080000_subscriptions_athlete_read_model.sql) plus pure
 * presentation helpers. This module never computes coverage/allowance/freeze status itself --
 * every number and boolean here comes straight from the backend. Its only job is shaping that
 * data for the screen and phrasing it in natural, non-technical language.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubscriptionTier } from "./subscriptions";

export type AthleteFreezeWindow = { freeze_from: string; freeze_until: string };

export type AthleteWeeklyUsageRow = {
  tier: SubscriptionTier;
  /** As configured by the manager -- never the number to show as the athlete's "of Y" denominator. */
  configured_weekly_limit: number;
  /** Prorated for this week's frozen Sun-Fri days (subscription_effective_weekly_limit) -- this is
   * the one the athlete UI must display. */
  effective_weekly_limit: number;
  used: number;
};

export type AthleteSubscriptionSummary =
  | { ok: true; has_subscription: false }
  | {
      ok: true;
      has_subscription: true;
      is_frozen: boolean;
      monthly_price_ils: number;
      plan_start_date: string;
      /** Configured end date, unaffected by freezes -- prefer effective_plan_end_date for display. */
      plan_end_date: string | null;
      /** Configured end date extended by every applicable freeze day; null iff has_no_end_date. */
      effective_plan_end_date: string | null;
      has_no_end_date: boolean;
      /** Already reflects cumulative freeze shift -- never recompute this on the client. */
      next_billing_date: string | null;
      current_freeze: AthleteFreezeWindow | null;
      upcoming_freeze: AthleteFreezeWindow | null;
      week_start: string;
      allowances: Partial<Record<SubscriptionTier, number>>;
      weekly_usage: AthleteWeeklyUsageRow[];
    };

export type AthleteSubscriptionError = { ok: false; error: string };

export async function rpcGetMySubscription(
  supabase: SupabaseClient
): Promise<AthleteSubscriptionSummary | AthleteSubscriptionError> {
  const { data, error } = await supabase.rpc("get_my_subscription");
  if (error) throw error;
  return data as AthleteSubscriptionSummary | AthleteSubscriptionError;
}

// ---------------------------------------------------------------------------
// Pure presentation / read-model helpers — no RPC calls, no React, fully unit-testable.
// ---------------------------------------------------------------------------

export type AthleteTierUsage = {
  tier: SubscriptionTier;
  /** The EFFECTIVE (prorated) weekly limit -- always the "of Y" denominator to render. */
  weeklyLimit: number;
  used: number;
  /** Never negative, even if the backend momentarily shows used > limit (e.g. right after a
   * manager lowers an allowance mid-week) -- the athlete should never see "-1 left". */
  remaining: number;
  exhausted: boolean;
};

export type AthleteSubscriptionViewModel =
  | { kind: "none" }
  | {
      kind: "active" | "frozen";
      monthlyPriceIls: number;
      planStartDate: string;
      /** Effective (freeze-extended) end date -- always the one to display; null iff no end date. */
      planEndDate: string | null;
      hasNoEndDate: boolean;
      /** Already reflects cumulative freeze shift. */
      nextBillingDate: string | null;
      currentFreeze: AthleteFreezeWindow | null;
      upcomingFreeze: AthleteFreezeWindow | null;
      tiers: AthleteTierUsage[];
    };

export function tierUsageFromRow(row: AthleteWeeklyUsageRow): AthleteTierUsage {
  const remaining = Math.max(0, row.effective_weekly_limit - row.used);
  return {
    tier: row.tier,
    weeklyLimit: row.effective_weekly_limit,
    used: row.used,
    remaining,
    exhausted: row.used >= row.effective_weekly_limit,
  };
}

/** Shapes the raw RPC payload into what the screen renders. The only "decision" made here is
 * cosmetic (is_frozen -> which of the two non-empty view kinds to render); every entitlement fact
 * is passed through unchanged from the backend -- planEndDate here is already the EFFECTIVE
 * (freeze-extended) date, never the raw configured one, per the freeze-as-pause correction. */
export function buildAthleteSubscriptionViewModel(
  summary: AthleteSubscriptionSummary
): AthleteSubscriptionViewModel {
  if (!summary.has_subscription) return { kind: "none" };
  return {
    kind: summary.is_frozen ? "frozen" : "active",
    monthlyPriceIls: summary.monthly_price_ils,
    planStartDate: summary.plan_start_date,
    planEndDate: summary.effective_plan_end_date,
    hasNoEndDate: summary.has_no_end_date,
    nextBillingDate: summary.next_billing_date,
    currentFreeze: summary.current_freeze,
    upcomingFreeze: summary.upcoming_freeze,
    tiers: summary.weekly_usage.map(tierUsageFromRow),
  };
}

/** Natural "N session(s) left this week" sentence. Only meaningful when NOT exhausted -- callers
 * should show athleteSubscription.allowanceUsedUp instead once remaining reaches 0, per product
 * requirement to never present "0 left" as the primary wording. */
export function sessionsLeftLabel(remaining: number, t: (key: string) => string): string {
  if (remaining === 1) return t("athleteSubscription.oneLeft");
  return t("athleteSubscription.leftThisWeek").replace("{n}", String(remaining));
}

export function usedOfLimitLabel(used: number, limit: number, t: (key: string) => string): string {
  return t("athleteSubscription.usedOfLimit").replace("{used}", String(used)).replace("{limit}", String(limit));
}

/** The freeze's own inclusive last day, plus one -- the subscription resumes the day AFTER
 * freeze_until, never on freeze_until itself. Pure calendar arithmetic (not a business-rule
 * calculation), computed via UTC Date normalization so month/year rollovers (Dec 31 -> Jan 1,
 * Feb 28/29 -> Mar 1) are always correct. */
export function resumeDateFromFreezeUntil(freezeUntilIso: string): string {
  const [y, m, d] = freezeUntilIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
