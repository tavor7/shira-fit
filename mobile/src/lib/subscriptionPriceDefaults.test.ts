import {
  applySuggestion,
  editPrice,
  groupOnlyQuota,
  parseDefaultPriceInput,
  suggestedMonthlyPrice,
  type PriceFieldState,
} from "./subscriptionPriceDefaults";

const DEFAULTS = { 1: 250, 2: 400, 3: 520.5 } as const;

describe("groupOnlyQuota / suggestedMonthlyPrice", () => {
  it("suggests the configured default for a group-only quota of 1-4", () => {
    expect(suggestedMonthlyPrice({ group: 2 }, DEFAULTS)).toEqual({ quota: 2, price: 400 });
    expect(suggestedMonthlyPrice({ group: 3, personal: 0, pair: 0 }, DEFAULTS)).toEqual({ quota: 3, price: 520.5 });
  });
  it("never invents a price: no default configured for that quota", () => {
    expect(suggestedMonthlyPrice({ group: 4 }, DEFAULTS)).toBeNull();
  });
  it("no suggestion outside 1-4", () => {
    expect(groupOnlyQuota({ group: 0 })).toBeNull();
    expect(groupOnlyQuota({ group: 5 })).toBeNull();
    expect(groupOnlyQuota({})).toBeNull();
  });
  it("no suggestion when other session types are included", () => {
    expect(suggestedMonthlyPrice({ group: 2, personal: 1 }, DEFAULTS)).toBeNull();
    expect(suggestedMonthlyPrice({ group: 2, quartet: 1 }, DEFAULTS)).toBeNull();
  });
});

describe("price field: suggested vs manual", () => {
  const empty: PriceFieldState = { text: "", source: "empty" };
  it("fills an empty field with the suggestion and follows quota changes", () => {
    const s1 = applySuggestion(empty, { quota: 1, price: 250 });
    expect(s1).toEqual({ text: "250", source: "suggested" });
    const s2 = applySuggestion(s1, { quota: 3, price: 520.5 });
    expect(s2).toEqual({ text: "520.50", source: "suggested" });
  });
  it("clears a suggested price when the suggestion no longer applies", () => {
    expect(applySuggestion({ text: "250", source: "suggested" }, null)).toEqual(empty);
  });
  it("never overwrites a price the manager typed", () => {
    const manual = editPrice("333");
    expect(manual.source).toBe("manual");
    expect(applySuggestion(manual, { quota: 2, price: 400 })).toBe(manual);
    expect(applySuggestion(manual, null)).toBe(manual);
  });
  it("clearing the field hands control back to suggestions", () => {
    const cleared = editPrice("  ");
    expect(cleared.source).toBe("empty");
    expect(applySuggestion(cleared, { quota: 2, price: 400 })).toEqual({ text: "400", source: "suggested" });
  });
});

describe("parseDefaultPriceInput", () => {
  it.each([
    ["", null],
    ["250", 250],
    ["250.5", 250.5],
    ["250,75", 250.75],
    ["0", 0],
    ["100000", 100000],
  ])("%s -> %s", (raw, expected) => {
    expect(parseDefaultPriceInput(raw)).toBe(expected);
  });
  it.each(["-1", "abc", "1.234", "100000.01", "1e3"])("rejects %s", (raw) => {
    expect(parseDefaultPriceInput(raw)).toBeUndefined();
  });
});
