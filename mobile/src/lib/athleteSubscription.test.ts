import {
  buildAthleteSubscriptionViewModel,
  resumeDateFromFreezeUntil,
  sessionsLeftLabel,
  tierUsageFromRow,
  usedOfLimitLabel,
  type AthleteSubscriptionSummary,
} from "./athleteSubscription";

const t = (key: string) => key;

describe("tierUsageFromRow", () => {
  it("uses effective_weekly_limit (not configured_weekly_limit) as the denominator", () => {
    const row = tierUsageFromRow({ tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 1, used: 0 });
    expect(row).toEqual({ tier: "group", weeklyLimit: 1, used: 0, remaining: 1, exhausted: false });
  });

  it("marks a tier exhausted exactly when used reaches the effective limit", () => {
    expect(tierUsageFromRow({ tier: "personal", configured_weekly_limit: 1, effective_weekly_limit: 1, used: 0 }).exhausted).toBe(false);
    expect(tierUsageFromRow({ tier: "personal", configured_weekly_limit: 1, effective_weekly_limit: 1, used: 1 }).exhausted).toBe(true);
  });

  it("never reports negative remaining, even if used exceeds the effective limit", () => {
    const row = tierUsageFromRow({ tier: "pair", configured_weekly_limit: 2, effective_weekly_limit: 2, used: 5 });
    expect(row.remaining).toBe(0);
    expect(row.exhausted).toBe(true);
  });
});

describe("buildAthleteSubscriptionViewModel", () => {
  it("returns kind 'none' when the athlete has no subscription", () => {
    const summary: AthleteSubscriptionSummary = { ok: true, has_subscription: false };
    expect(buildAthleteSubscriptionViewModel(summary)).toEqual({ kind: "none" });
  });

  it("maps an active subscription with several included tiers", () => {
    const summary: AthleteSubscriptionSummary = {
      ok: true,
      has_subscription: true,
      is_frozen: false,
      monthly_price_ils: 450,
      plan_start_date: "2026-01-01",
      plan_end_date: null,
      effective_plan_end_date: null,
      has_no_end_date: true,
      next_billing_date: "2026-10-01",
      current_freeze: null,
      upcoming_freeze: null,
      week_start: "2026-09-27",
      allowances: { group: 3, personal: 1 },
      weekly_usage: [
        { tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 3, used: 2 },
        { tier: "personal", configured_weekly_limit: 1, effective_weekly_limit: 1, used: 0 },
      ],
    };
    const vm = buildAthleteSubscriptionViewModel(summary);
    expect(vm.kind).toBe("active");
    if (vm.kind === "none") throw new Error("unreachable");
    expect(vm.hasNoEndDate).toBe(true);
    expect(vm.planEndDate).toBeNull();
    expect(vm.tiers).toEqual([
      { tier: "group", weeklyLimit: 3, used: 2, remaining: 1, exhausted: false },
      { tier: "personal", weeklyLimit: 1, used: 0, remaining: 1, exhausted: false },
    ]);
  });

  it("uses effective_plan_end_date (freeze-extended), never the raw configured plan_end_date, for display", () => {
    const summary: AthleteSubscriptionSummary = {
      ok: true,
      has_subscription: true,
      is_frozen: false,
      monthly_price_ils: 300,
      plan_start_date: "2026-01-01",
      plan_end_date: "2026-12-31",
      effective_plan_end_date: "2027-01-07",
      has_no_end_date: false,
      next_billing_date: "2026-10-01",
      current_freeze: null,
      upcoming_freeze: null,
      week_start: "2026-09-27",
      allowances: { group: 3 },
      weekly_usage: [{ tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 3, used: 0 }],
    };
    const vm = buildAthleteSubscriptionViewModel(summary);
    if (vm.kind === "none") throw new Error("unreachable");
    expect(vm.planEndDate).toBe("2027-01-07");
  });

  it("maps a prorated (frozen-week) tier using the effective limit as both denominator and exhaustion check", () => {
    const summary: AthleteSubscriptionSummary = {
      ok: true,
      has_subscription: true,
      is_frozen: false,
      monthly_price_ils: 300,
      plan_start_date: "2026-01-01",
      plan_end_date: "2026-12-31",
      effective_plan_end_date: "2026-12-31",
      has_no_end_date: false,
      next_billing_date: "2026-10-01",
      current_freeze: null,
      upcoming_freeze: null,
      week_start: "2026-09-27",
      allowances: { group: 3 },
      // Configured 3, but a Sun-Wed freeze this week prorates it down to 1 (CEIL(3*2/6)).
      weekly_usage: [{ tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 1, used: 1 }],
    };
    const vm = buildAthleteSubscriptionViewModel(summary);
    if (vm.kind === "none") throw new Error("unreachable");
    expect(vm.tiers[0]).toEqual({ tier: "group", weeklyLimit: 1, used: 1, remaining: 0, exhausted: true });
  });

  it("surfaces kind 'frozen' and the current freeze window when is_frozen is true", () => {
    const summary: AthleteSubscriptionSummary = {
      ok: true,
      has_subscription: true,
      is_frozen: true,
      monthly_price_ils: 300,
      plan_start_date: "2026-01-01",
      plan_end_date: null,
      effective_plan_end_date: null,
      has_no_end_date: true,
      next_billing_date: "2026-10-07",
      current_freeze: { freeze_from: "2026-09-28", freeze_until: "2026-10-06" },
      upcoming_freeze: null,
      week_start: "2026-09-27",
      allowances: { group: 3 },
      weekly_usage: [{ tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 3, used: 0 }],
    };
    const vm = buildAthleteSubscriptionViewModel(summary);
    expect(vm.kind).toBe("frozen");
    if (vm.kind === "none") throw new Error("unreachable");
    expect(vm.currentFreeze).toEqual({ freeze_from: "2026-09-28", freeze_until: "2026-10-06" });
  });

  it("passes through an upcoming freeze without needing one to be currently active", () => {
    const summary: AthleteSubscriptionSummary = {
      ok: true,
      has_subscription: true,
      is_frozen: false,
      monthly_price_ils: 300,
      plan_start_date: "2026-01-01",
      plan_end_date: null,
      effective_plan_end_date: null,
      has_no_end_date: true,
      next_billing_date: "2026-10-01",
      current_freeze: null,
      upcoming_freeze: { freeze_from: "2026-10-10", freeze_until: "2026-10-17" },
      week_start: "2026-09-27",
      allowances: { group: 3 },
      weekly_usage: [{ tier: "group", configured_weekly_limit: 3, effective_weekly_limit: 3, used: 0 }],
    };
    const vm = buildAthleteSubscriptionViewModel(summary);
    expect(vm.kind).toBe("active");
    if (vm.kind === "none") throw new Error("unreachable");
    expect(vm.upcomingFreeze).toEqual({ freeze_from: "2026-10-10", freeze_until: "2026-10-17" });
  });
});

describe("sessionsLeftLabel", () => {
  it("uses the singular key for exactly 1 remaining", () => {
    expect(sessionsLeftLabel(1, t)).toBe("athleteSubscription.oneLeft");
  });

  it("interpolates the count for 2 or more remaining", () => {
    expect(sessionsLeftLabel(2, t)).toBe("athleteSubscription.leftThisWeek".replace("{n}", "2"));
    expect(sessionsLeftLabel(5, t)).toBe("athleteSubscription.leftThisWeek".replace("{n}", "5"));
  });
});

describe("usedOfLimitLabel", () => {
  it("interpolates both used and limit", () => {
    expect(usedOfLimitLabel(2, 3, t)).toBe("athleteSubscription.usedOfLimit".replace("{used}", "2").replace("{limit}", "3"));
  });
});

describe("resumeDateFromFreezeUntil", () => {
  it("returns the day after freeze_until, not freeze_until itself", () => {
    expect(resumeDateFromFreezeUntil("2026-10-07")).toBe("2026-10-08");
  });

  it("rolls over a month boundary", () => {
    expect(resumeDateFromFreezeUntil("2026-10-31")).toBe("2026-11-01");
  });

  it("rolls over a year boundary", () => {
    expect(resumeDateFromFreezeUntil("2026-12-31")).toBe("2027-01-01");
  });

  it("rolls over February correctly in a non-leap year", () => {
    expect(resumeDateFromFreezeUntil("2026-02-28")).toBe("2026-03-01");
  });

  it("rolls over February correctly in a leap year", () => {
    expect(resumeDateFromFreezeUntil("2028-02-29")).toBe("2028-03-01");
  });
});
