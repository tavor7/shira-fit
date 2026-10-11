import { normalizeShortMonth } from "./appLocale";
import { formatISODatePricing, formatISODateShortDisplay } from "./isoDate";

describe("normalizeShortMonth (Phase 5 / P)", () => {
  it("turns en-GB's four-letter September into the three-letter convention", () => {
    expect(normalizeShortMonth("28 Sept 2026")).toBe("28 Sep 2026");
    expect(normalizeShortMonth("Mon, 28 Sept")).toBe("Mon, 28 Sep");
  });

  it("leaves other months, words containing 'Sept', and Hebrew untouched", () => {
    expect(normalizeShortMonth("8 Oct 2026")).toBe("8 Oct 2026");
    expect(normalizeShortMonth("September")).toBe("September");
    expect(normalizeShortMonth("28 בספט׳ 2026")).toBe("28 בספט׳ 2026");
  });

  it("is applied by the shared short-date formatters", () => {
    expect(formatISODatePricing("2026-09-28", "en")).not.toMatch(/Sept\b/);
    expect(formatISODatePricing("2026-09-28", "en")).toMatch(/Sep\b/);
    expect(formatISODateShortDisplay("2026-09-28", "en")).not.toMatch(/Sept\b/);
  });
});
