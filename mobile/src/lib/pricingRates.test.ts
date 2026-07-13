import {
  findPricingOverlap,
  isPricingOverlapDbError,
  pricingActiveOnDate,
  pricingOpenEnd,
  pricingPeriodStatus,
  pricingRangesOverlap,
  resolveTierPriceForDate,
  sortPricingRows,
  splitPricingPeriods,
  validatePricingPeriodInput,
  type PricingRateTierRow,
} from "./pricingRates";

describe("pricingOpenEnd", () => {
  it("returns the sentinel open-end date for null/undefined/empty", () => {
    expect(pricingOpenEnd(null)).toBe("9999-12-31");
    expect(pricingOpenEnd(undefined)).toBe("9999-12-31");
    expect(pricingOpenEnd("  ")).toBe("9999-12-31");
  });

  it("returns the trimmed date when present", () => {
    expect(pricingOpenEnd(" 2026-12-31 ")).toBe("2026-12-31");
  });
});

describe("pricingRangesOverlap", () => {
  it("detects overlap between two open-ended ranges", () => {
    expect(
      pricingRangesOverlap(
        { effective_from: "2026-01-01", effective_to: null },
        { effective_from: "2026-06-01", effective_to: null }
      )
    ).toBe(true);
  });

  it("detects non-overlap when one range ends before the other starts", () => {
    expect(
      pricingRangesOverlap(
        { effective_from: "2026-01-01", effective_to: "2026-03-01" },
        { effective_from: "2026-03-02", effective_to: null }
      )
    ).toBe(false);
  });

  it("treats a shared boundary day as overlapping (inclusive ranges)", () => {
    expect(
      pricingRangesOverlap(
        { effective_from: "2026-01-01", effective_to: "2026-03-01" },
        { effective_from: "2026-03-01", effective_to: null }
      )
    ).toBe(true);
  });

  it("is false when either range has no effective_from", () => {
    expect(
      pricingRangesOverlap({ effective_from: undefined, effective_to: null }, { effective_from: "2026-01-01" })
    ).toBe(false);
  });
});

describe("pricingActiveOnDate", () => {
  it("is true when asOf falls within [from, to]", () => {
    expect(pricingActiveOnDate("2026-01-01", "2026-12-31", "2026-06-01")).toBe(true);
  });

  it("is true for an open-ended period regardless of how far out asOf is", () => {
    expect(pricingActiveOnDate("2026-01-01", null, "2030-01-01")).toBe(true);
  });

  it("is false before the start date or after the end date", () => {
    expect(pricingActiveOnDate("2026-01-01", "2026-12-31", "2025-12-31")).toBe(false);
    expect(pricingActiveOnDate("2026-01-01", "2026-12-31", "2027-01-01")).toBe(false);
  });

  it("is false when effective_from or asOf is not a valid ISO date", () => {
    expect(pricingActiveOnDate("not-a-date", null, "2026-06-01")).toBe(false);
    expect(pricingActiveOnDate("2026-01-01", null, "not-a-date")).toBe(false);
  });
});

describe("validatePricingPeriodInput", () => {
  it("accepts a valid open-ended period", () => {
    expect(validatePricingPeriodInput("2026-01-01", "")).toEqual({
      ok: true,
      effective_from: "2026-01-01",
      effective_to: null,
    });
  });

  it("accepts a valid closed period", () => {
    expect(validatePricingPeriodInput("2026-01-01", "2026-06-01")).toEqual({
      ok: true,
      effective_from: "2026-01-01",
      effective_to: "2026-06-01",
    });
  });

  it("rejects an invalid start date", () => {
    expect(validatePricingPeriodInput("not-a-date", "")).toEqual({
      ok: false,
      errorKey: "pricing.invalidPeriod",
    });
  });

  it("rejects an end date before the start date", () => {
    expect(validatePricingPeriodInput("2026-06-01", "2026-01-01")).toEqual({
      ok: false,
      errorKey: "pricing.invalidPeriod",
    });
  });
});

describe("findPricingOverlap", () => {
  const existing = [
    { id: "a", max_participants: 4, effective_from: "2026-01-01", effective_to: "2026-06-01" },
    { id: "b", max_participants: 8, effective_from: "2026-01-01", effective_to: null },
  ];

  it("finds an overlapping row", () => {
    const hit = findPricingOverlap({ effective_from: "2026-03-01", effective_to: null }, existing, {
      sameTier: (row) => row.max_participants === 4,
    });
    expect(hit?.id).toBe("a");
  });

  it("excludes a row by id (editing-in-place case)", () => {
    const hit = findPricingOverlap({ effective_from: "2026-03-01", effective_to: null }, existing, {
      excludeId: "a",
      sameTier: (row) => row.max_participants === 4,
    });
    expect(hit).toBeNull();
  });

  it("returns null when nothing overlaps", () => {
    const hit = findPricingOverlap({ effective_from: "2027-01-01", effective_to: null }, existing, {
      sameTier: (row) => row.max_participants === 4,
    });
    expect(hit).toBeNull();
  });
});

describe("isPricingOverlapDbError", () => {
  it("recognizes Postgres exclusion-constraint style messages", () => {
    expect(isPricingOverlapDbError("conflicting key value violates exclusion constraint")).toBe(true);
    expect(isPricingOverlapDbError("Overlapping period for this tier")).toBe(true);
  });

  it("does not misclassify an unrelated error", () => {
    expect(isPricingOverlapDbError("permission denied for table pricing")).toBe(false);
  });
});

describe("sortPricingRows", () => {
  it("sorts by capacity ascending, then by effective_from descending within a capacity", () => {
    const rows = [
      { max_participants: 8, effective_from: "2026-01-01" },
      { max_participants: 4, effective_from: "2026-01-01" },
      { max_participants: 4, effective_from: "2026-06-01" },
    ];
    expect(sortPricingRows(rows)).toEqual([
      { max_participants: 4, effective_from: "2026-06-01" },
      { max_participants: 4, effective_from: "2026-01-01" },
      { max_participants: 8, effective_from: "2026-01-01" },
    ]);
  });

  it("does not mutate the input array", () => {
    const rows = [{ max_participants: 2, effective_from: "2026-01-01" }];
    const sorted = sortPricingRows(rows);
    expect(sorted).not.toBe(rows);
  });
});

describe("resolveTierPriceForDate", () => {
  const tiers: PricingRateTierRow[] = [
    { max_participants: 4, price_ils: 100, effective_from: "2026-01-01", effective_to: "2026-05-31" },
    { max_participants: 4, price_ils: 120, effective_from: "2026-06-01", effective_to: null },
    { max_participants: 8, price_ils: 200, effective_from: "2026-01-01", effective_to: null },
  ];

  it("picks the tier active on the given date for that capacity", () => {
    expect(resolveTierPriceForDate(tiers, 4, "2026-03-01")).toBe(100);
    expect(resolveTierPriceForDate(tiers, 4, "2026-07-01")).toBe(120);
  });

  it("ignores tiers for a different capacity", () => {
    expect(resolveTierPriceForDate(tiers, 8, "2026-03-01")).toBe(200);
  });

  it("returns null when no tier is active for that capacity/date", () => {
    expect(resolveTierPriceForDate(tiers, 15, "2026-03-01")).toBeNull();
  });

  it("when multiple candidates match, prefers the most recently effective one", () => {
    const overlapping: PricingRateTierRow[] = [
      { max_participants: 4, price_ils: 90, effective_from: "2026-01-01", effective_to: null },
      { max_participants: 4, price_ils: 110, effective_from: "2026-02-01", effective_to: null },
    ];
    expect(resolveTierPriceForDate(overlapping, 4, "2026-06-01")).toBe(110);
  });
});

describe("pricingPeriodStatus", () => {
  it("is upcoming when effective_from is after asOf", () => {
    expect(pricingPeriodStatus("2026-12-01", null, "2026-06-01")).toBe("upcoming");
  });

  it("is past when effective_to is before asOf", () => {
    expect(pricingPeriodStatus("2026-01-01", "2026-03-01", "2026-06-01")).toBe("past");
  });

  it("is current when asOf falls within the period", () => {
    expect(pricingPeriodStatus("2026-01-01", "2026-12-31", "2026-06-01")).toBe("current");
    expect(pricingPeriodStatus("2026-01-01", null, "2026-06-01")).toBe("current");
  });

  it("returns null for a missing or invalid effective_from", () => {
    expect(pricingPeriodStatus(undefined, null, "2026-06-01")).toBeNull();
    expect(pricingPeriodStatus("not-a-date", null, "2026-06-01")).toBeNull();
  });
});

describe("splitPricingPeriods", () => {
  it("splits into active (current + upcoming) and past groups", () => {
    const periods: PricingRateTierRow[] = [
      { max_participants: 4, price_ils: 90, effective_from: "2026-01-01", effective_to: "2026-02-01" }, // past
      { max_participants: 4, price_ils: 100, effective_from: "2026-03-01", effective_to: null }, // current
      { max_participants: 4, price_ils: 110, effective_from: "2026-12-01", effective_to: null }, // upcoming
    ];
    const { active, past } = splitPricingPeriods(periods, "2026-06-01");
    expect(active.map((p) => p.price_ils)).toEqual([110, 100]);
    expect(past.map((p) => p.price_ils)).toEqual([90]);
  });
});
