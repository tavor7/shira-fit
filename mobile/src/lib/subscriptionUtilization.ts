import type { SubscriptionWeekUtilization } from "./subscriptions";

export type UtilizationLegendKey = "used" | "unmarked" | "reserved" | "remaining" | "unused";

export type UtilizationViewModel = {
  /** Sessions holding allowance: used + unmarked + reserved. */
  occupied: number;
  available: number;
  /** Rounded share of `available`, not clamped: over-allocation must stay visible. */
  occupiedPct: number;
  usedPct: number;
  headlineKey: "subscriptions.overview.pctClosed" | "subscriptions.overview.pctCurrent" | "subscriptions.overview.pctFuture";
  /** Widths of the bar's parts in percent. Always sums to at most 100, whatever the data says. */
  bar: { used: number; unmarked: number; reserved: number };
  legend: { key: UtilizationLegendKey; value: number }[];
  empty: boolean;
};

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Display shaping only: every number comes from manager_subscription_week_utilization. In a closed week nothing can still
 * happen, so "remaining" reads as "unused". An ended session with no attendance recorded keeps its own entry and is never
 * presented as attended.
 */
export function buildUtilizationViewModel(u: SubscriptionWeekUtilization): UtilizationViewModel {
  const occupied = u.used + u.unmarked + u.reserved;
  const scale = Math.max(u.available, occupied);
  const legend: UtilizationViewModel["legend"] = [];
  if (u.mode !== "future" || u.used > 0) legend.push({ key: "used", value: u.used });
  if (u.unmarked > 0) legend.push({ key: "unmarked", value: u.unmarked });
  if (u.mode !== "closed") legend.push({ key: "reserved", value: u.reserved });
  legend.push({ key: u.mode === "closed" ? "unused" : "remaining", value: u.remaining });
  return {
    occupied,
    available: u.available,
    occupiedPct: pct(occupied, u.available),
    usedPct: pct(u.used, u.available),
    headlineKey:
      u.mode === "closed"
        ? "subscriptions.overview.pctClosed"
        : u.mode === "future"
          ? "subscriptions.overview.pctFuture"
          : "subscriptions.overview.pctCurrent",
    bar: {
      used: scale > 0 ? (u.used / scale) * 100 : 0,
      unmarked: scale > 0 ? (u.unmarked / scale) * 100 : 0,
      reserved: scale > 0 ? (u.reserved / scale) * 100 : 0,
    },
    legend,
    empty: u.available === 0 && occupied === 0,
  };
}

export type OverviewAttentionItem = { key: string; count: number; amountIls?: number };

/** At most what a manager should act on, in order of consequence. Nothing is shown when nothing needs attention. */
export function buildOverviewAttention(input: {
  overAllocated: number;
  openBalanceCount: number;
  openBalanceIls: number;
  chargesNext7Count: number;
  chargesNext7Ils: number;
  endingNext14Count: number;
  pendingCorrections: number;
  awaitingAccounting: number;
}): OverviewAttentionItem[] {
  const out: OverviewAttentionItem[] = [];
  if (input.overAllocated > 0) out.push({ key: "overAllocated", count: input.overAllocated });
  if (input.pendingCorrections > 0) out.push({ key: "pendingCorrections", count: input.pendingCorrections });
  if (input.awaitingAccounting > 0) out.push({ key: "awaitingAccounting", count: input.awaitingAccounting });
  if (input.openBalanceCount > 0) out.push({ key: "openBalance", count: input.openBalanceCount, amountIls: input.openBalanceIls });
  if (input.chargesNext7Count > 0) out.push({ key: "chargesSoon", count: input.chargesNext7Count, amountIls: input.chargesNext7Ils });
  if (input.endingNext14Count > 0) out.push({ key: "endingSoon", count: input.endingNext14Count });
  return out;
}
