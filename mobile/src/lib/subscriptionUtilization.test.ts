import { buildOverviewAttention, buildUtilizationViewModel } from "./subscriptionUtilization";
import type { SubscriptionWeekUtilization } from "./subscriptions";

function week(p: Partial<SubscriptionWeekUtilization>): SubscriptionWeekUtilization {
  return {
    ok: true, week_start: "2026-11-01", week_end: "2026-11-07", mode: "current", available: 0, used: 0, attended: 0, penalty: 0,
    unmarked: 0, reserved: 0, remaining: 0, over_allocated: 0, released: 0, extra_regular_price: 0, rows: [], ...p,
  };
}

describe("buildUtilizationViewModel", () => {
  it("adds used, unmarked and reserved into the headline, and keeps used apart", () => {
    const vm = buildUtilizationViewModel(week({ available: 20, used: 5, unmarked: 4, reserved: 8, remaining: 3 }));
    expect(vm.occupied).toBe(17);
    expect(vm.occupiedPct).toBe(85);
    expect(vm.usedPct).toBe(25);
    expect(vm.legend.map((l) => [l.key, l.value])).toEqual([["used", 5], ["unmarked", 4], ["reserved", 8], ["remaining", 3]]);
  });

  it("calls what is left in a closed week unused, and shows no reservations", () => {
    const vm = buildUtilizationViewModel(week({ mode: "closed", available: 13, used: 8, remaining: 5 }));
    expect(vm.headlineKey).toBe("subscriptions.overview.pctClosed");
    expect(vm.legend.map((l) => l.key)).toEqual(["used", "unused"]);
  });

  it("does not show a used figure for a future week", () => {
    const vm = buildUtilizationViewModel(week({ mode: "future", available: 22, reserved: 4, remaining: 18 }));
    expect(vm.legend.map((l) => l.key)).toEqual(["reserved", "remaining"]);
  });

  it("never lets the bar overflow, while the percentage still shows over-allocation", () => {
    const vm = buildUtilizationViewModel(week({ available: 2, used: 2, reserved: 1, over_allocated: 1 }));
    expect(vm.occupiedPct).toBe(150);
    expect(vm.bar.used + vm.bar.unmarked + vm.bar.reserved).toBeCloseTo(100);
  });

  it("reports an empty week", () => {
    expect(buildUtilizationViewModel(week({})).empty).toBe(true);
  });
});

describe("buildOverviewAttention", () => {
  const none = { overAllocated: 0, openBalanceCount: 0, openBalanceIls: 0, chargesNext7Count: 0, chargesNext7Ils: 0, endingNext14Count: 0, pendingCorrections: 0, awaitingAccounting: 0 };
  it("is empty when nothing needs attention", () => {
    expect(buildOverviewAttention(none)).toEqual([]);
  });
  it("keeps an unresolved correction visible, ahead of routine items", () => {
    const items = buildOverviewAttention({ ...none, pendingCorrections: 2, chargesNext7Count: 1, chargesNext7Ils: 360 });
    expect(items.map((i) => i.key)).toEqual(["pendingCorrections", "chargesSoon"]);
    expect(buildOverviewAttention({ ...none, pendingCorrections: 1, awaitingAccounting: 1 }).map((i) => i.key)).toEqual(["pendingCorrections", "awaitingAccounting"]);
  });
  it("puts an integrity problem first", () => {
    const items = buildOverviewAttention({ ...none, overAllocated: 1, openBalanceCount: 2, openBalanceIls: 720 });
    expect(items.map((i) => i.key)).toEqual(["overAllocated", "openBalance"]);
  });
});
