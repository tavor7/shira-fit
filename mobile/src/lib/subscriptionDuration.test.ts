import { durationMatchingEndDate, endDateForDuration, nextAnchorDate, SUBSCRIPTION_DURATION_MONTHS } from "./subscriptionDuration";

describe("nextAnchorDate (mirrors public.subscription_next_anchor_date)", () => {
  it.each([
    [31, "2026-01-31", "2026-02-28"],
    [31, "2026-02-28", "2026-03-31"],
    [31, "2028-01-31", "2028-02-29"],
    [29, "2028-02-29", "2028-03-29"],
    [29, "2029-01-29", "2029-02-28"],
    [15, "2026-12-15", "2027-01-15"],
    [30, "2026-04-30", "2026-05-30"],
    [1, "2026-03-01", "2026-04-01"],
  ])("anchor %i from %s -> %s", (anchor, from, expected) => {
    expect(nextAnchorDate(anchor, from)).toBe(expected);
  });
});

describe("endDateForDuration — calendar months, inclusive end = day before the N-th billing anchor", () => {
  it.each([
    // January 31 (anchor 31 clamps to the month's last day and then returns to 31)
    ["2026-01-31", 1, "2026-02-27"],
    ["2026-01-31", 3, "2026-04-29"],
    ["2026-01-31", 6, "2026-07-30"],
    ["2026-01-31", 12, "2027-01-30"],
    // leap years
    ["2028-01-31", 1, "2028-02-28"],
    ["2028-02-29", 1, "2028-03-28"],
    ["2028-02-29", 12, "2029-02-27"],
    ["2027-02-28", 12, "2028-02-27"],
    ["2024-02-29", 6, "2024-08-28"],
    // month and year boundaries
    ["2026-03-01", 1, "2026-03-31"],
    ["2026-12-15", 1, "2027-01-14"],
    ["2026-12-31", 1, "2027-01-30"],
    ["2026-11-30", 3, "2027-02-27"],
    ["2026-10-11", 12, "2027-10-10"],
    ["2026-08-31", 6, "2027-02-27"],
  ])("%s + %i month(s) -> %s", (start, months, expected) => {
    expect(endDateForDuration(start, months)).toBe(expected);
  });

  it("never approximates a month as 30 days", () => {
    expect(endDateForDuration("2026-02-01", 1)).toBe("2026-02-28");
    expect(endDateForDuration("2026-07-01", 1)).toBe("2026-07-31");
  });

  it("honours an explicit anchor day", () => {
    expect(endDateForDuration("2026-01-10", 1, 31)).toBe("2026-02-27");
  });

  it("rejects invalid input instead of guessing", () => {
    expect(endDateForDuration("2026-02-30", 1)).toBeNull();
    expect(endDateForDuration("", 1)).toBeNull();
    expect(endDateForDuration("2026-01-01", 0)).toBeNull();
  });

  it("every preset ends after its start and is strictly increasing", () => {
    for (const start of ["2026-01-31", "2028-02-29", "2026-12-31", "2026-06-15"]) {
      const ends = SUBSCRIPTION_DURATION_MONTHS.map((m) => endDateForDuration(start, m)!);
      expect(ends.every((e) => e > start)).toBe(true);
      expect([...ends].sort()).toEqual(ends);
    }
  });
});

describe("durationMatchingEndDate", () => {
  it("recognises a preset end date", () => {
    expect(durationMatchingEndDate("2026-01-31", "2026-04-29")).toBe(3);
    expect(durationMatchingEndDate("2028-02-29", "2029-02-27")).toBe(12);
  });
  it("returns null for a manually chosen date (Custom)", () => {
    expect(durationMatchingEndDate("2026-01-31", "2026-02-28")).toBeNull();
    expect(durationMatchingEndDate("2026-01-31", "2026-05-15")).toBeNull();
  });
});
