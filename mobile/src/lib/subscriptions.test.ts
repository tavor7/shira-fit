import {
  SUBSCRIPTION_TIERS,
  allowancesRecordToArray,
  currentEffectiveChargeAmount,
  emptyWeeklyLimits,
  isValidIsoDate,
  validateCreateSubscriptionInput,
  type CreateSubscriptionInput,
  type SubscriptionChargeRow,
} from "./subscriptions";

describe("subscriptions: allowancesRecordToArray", () => {
  it("produces exactly the 7 tiers, in order, defaulting missing tiers to 0", () => {
    const arr = allowancesRecordToArray({ pair: 2 });
    expect(arr).toHaveLength(7);
    expect(arr.map((a) => a.tier)).toEqual([...SUBSCRIPTION_TIERS]);
    expect(arr.find((a) => a.tier === "pair")?.weekly_limit).toBe(2);
    expect(arr.filter((a) => a.tier !== "pair").every((a) => a.weekly_limit === 0)).toBe(true);
  });

  it("never invents a sentinel value for a no-end-date / unlimited-duration subscription — the record given is the record stored, exactly", () => {
    // Regression guard for the Phase 4A "100000 sentinel" bug: duration must never influence
    // allowances at the client layer either. This function has no awareness of end dates at all.
    const arr = allowancesRecordToArray({ group: 3 });
    expect(arr.find((a) => a.tier === "group")?.weekly_limit).toBe(3);
    expect(arr.every((a) => a.weekly_limit !== 100000)).toBe(true);
  });

  it("clamps negative/fractional input defensively", () => {
    const arr = allowancesRecordToArray({ trio: -5, quartet: 2.9 });
    expect(arr.find((a) => a.tier === "trio")?.weekly_limit).toBe(0);
    expect(arr.find((a) => a.tier === "quartet")?.weekly_limit).toBe(2);
  });
});

describe("subscriptions: emptyWeeklyLimits", () => {
  it("returns all 7 tiers at 0", () => {
    const empty = emptyWeeklyLimits();
    expect(SUBSCRIPTION_TIERS.every((t) => empty[t] === 0)).toBe(true);
  });
});

describe("subscriptions: isValidIsoDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isValidIsoDate("2026-09-25")).toBe(true);
  });
  it("rejects other formats and empty/null", () => {
    expect(isValidIsoDate("09/25/2026")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });
});

function baseInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    payeeId: "athlete-1",
    payeeIsManual: false,
    monthlyPriceIls: 300,
    startDate: "2026-09-25",
    endDate: null,
    allowances: { pair: 2 },
    ...overrides,
  };
}

describe("subscriptions: validateCreateSubscriptionInput", () => {
  it("accepts a well-formed input with no end date", () => {
    expect(validateCreateSubscriptionInput(baseInput())).toEqual([]);
  });

  it("requires a payee", () => {
    const errors = validateCreateSubscriptionInput(baseInput({ payeeId: "" }));
    expect(errors.some((e) => e.field === "payee")).toBe(true);
  });

  it("rejects a negative price", () => {
    const errors = validateCreateSubscriptionInput(baseInput({ monthlyPriceIls: -1 }));
    expect(errors.some((e) => e.field === "price")).toBe(true);
  });

  it("rejects an invalid start date", () => {
    const errors = validateCreateSubscriptionInput(baseInput({ startDate: "not-a-date" }));
    expect(errors.some((e) => e.field === "startDate")).toBe(true);
  });

  it("accepts a valid end date on/after the start date, and rejects one before it", () => {
    expect(validateCreateSubscriptionInput(baseInput({ endDate: "2026-10-25" }))).toEqual([]);
    const errors = validateCreateSubscriptionInput(baseInput({ endDate: "2026-01-01" }));
    expect(errors.some((e) => e.field === "endDate")).toBe(true);
  });

  it("treats endDate=null as valid (no-end-date is not an error state)", () => {
    expect(validateCreateSubscriptionInput(baseInput({ endDate: null }))).toEqual([]);
  });

  it("rejects a non-integer or negative allowance", () => {
    const errors1 = validateCreateSubscriptionInput(baseInput({ allowances: { pair: -1 } }));
    expect(errors1.some((e) => e.field === "allowance_pair")).toBe(true);
    const errors2 = validateCreateSubscriptionInput(baseInput({ allowances: { pair: 2.5 } }));
    expect(errors2.some((e) => e.field === "allowance_pair")).toBe(true);
  });

  it("a finite weekly allowance is independent of whether the subscription has an end date — both combinations are valid", () => {
    expect(validateCreateSubscriptionInput(baseInput({ endDate: null, allowances: { group: 3 } }))).toEqual([]);
    expect(
      validateCreateSubscriptionInput(baseInput({ endDate: "2027-09-25", allowances: { group: 3 } }))
    ).toEqual([]);
  });
});

function charge(overrides: Partial<SubscriptionChargeRow>): SubscriptionChargeRow {
  return { id: "c1", amount_ils: 300, charge_type: "recurring", reverses: null, created_at: "2026-01-01T00:00:00Z", ...overrides };
}

describe("subscriptions: currentEffectiveChargeAmount", () => {
  it("returns the single original charge when there is no correction", () => {
    expect(currentEffectiveChargeAmount([charge({ id: "a", amount_ils: 300 })])).toBe(300);
  });

  it("skips a charge that has already been reversed and returns the correction instead", () => {
    const charges: SubscriptionChargeRow[] = [
      charge({ id: "orig", amount_ils: 300, created_at: "2026-01-01T00:00:00Z" }),
      charge({ id: "rev", amount_ils: -300, charge_type: "reversal", reverses: "orig", created_at: "2026-01-02T00:00:00Z" }),
      charge({ id: "corr", amount_ils: 200, charge_type: "edit_correction", created_at: "2026-01-02T00:00:01Z" }),
    ];
    expect(currentEffectiveChargeAmount(charges)).toBe(200);
  });

  it("follows a chain of sequential corrections to the currently effective one, never the original", () => {
    const charges: SubscriptionChargeRow[] = [
      charge({ id: "c1", amount_ils: 300, created_at: "2026-01-01T00:00:00Z" }),
      charge({ id: "r1", amount_ils: -300, charge_type: "reversal", reverses: "c1", created_at: "2026-01-02T00:00:00Z" }),
      charge({ id: "c2", amount_ils: 250, charge_type: "edit_correction", created_at: "2026-01-02T00:00:01Z" }),
      charge({ id: "r2", amount_ils: -250, charge_type: "reversal", reverses: "c2", created_at: "2026-01-03T00:00:00Z" }),
      charge({ id: "c3", amount_ils: 180, charge_type: "edit_correction", created_at: "2026-01-03T00:00:01Z" }),
    ];
    expect(currentEffectiveChargeAmount(charges)).toBe(180);
  });

  it("returns null for an empty charge list", () => {
    expect(currentEffectiveChargeAmount([])).toBeNull();
  });
});
