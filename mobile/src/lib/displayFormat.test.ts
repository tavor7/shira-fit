import {
  displayDateRange,
  displayLtr,
  displayMoney,
  displayTimeRange,
  displayUserText,
  isolateNumericRanges,
  stripDisplayIsolates,
} from "./displayFormat";
import { formatISODateRangeCompact } from "./dateFormat";
import { formatSessionTimeRange } from "./sessionTime";

const LRI = "\u2066", FSI = "\u2068", PDI = "\u2069";

describe("displayMoney", () => {
  it.each([
    [480, "₪480"],
    [480.5, "₪480.50"],
    [480.05, "₪480.05"],
    [0, "₪0"],
    [1250.5, "₪1,250.50"],
    [1890.5, "₪1,890.50"],
    [1460, "₪1,460"],
    [1000000, "₪1,000,000"],
    [-50, "-₪50"],
    [-0.004, "₪0"],
    [99.999, "₪100"],
    [480.004, "₪480"],
  ])("%p → %p", (amount, expected) => {
    const out = displayMoney(amount);
    expect(out.startsWith(LRI) && out.endsWith(PDI)).toBe(true);
    expect(stripDisplayIsolates(out)).toBe(expected);
  });
  it("returns an empty string for non-finite input", () => {
    expect(displayMoney(NaN)).toBe("");
    expect(displayMoney(Infinity)).toBe("");
  });
  it("is the same in every language (no locale-dependent digits or symbol position)", () => {
    expect(displayMoney(480)).toBe(`${LRI}₪480${PDI}`);
  });
});

describe("displayTimeRange", () => {
  it("isolates the raw range without changing it", () => {
    expect(displayTimeRange("18:00", 60)).toBe(`${LRI}18:00–19:00${PDI}`);
    expect(stripDisplayIsolates(displayTimeRange("19:15:00", 75))).toBe(formatSessionTimeRange("19:15:00", 75));
  });
  it("keeps the midnight-crossing fallback", () => {
    expect(stripDisplayIsolates(displayTimeRange("23:30", 90))).toBe(formatSessionTimeRange("23:30", 90));
  });
  it("leaves the raw formatter free of isolates (data paths stay clean)", () => {
    expect(formatSessionTimeRange("18:00", 60)).toBe("18:00–19:00");
    expect(/[\u2066-\u2069]/.test(formatSessionTimeRange("18:00", 60))).toBe(false);
  });
});

describe("displayLtr / displayUserText", () => {
  it("wraps non-empty values only", () => {
    expect(displayLtr("4–10")).toBe(`${LRI}4–10${PDI}`);
    expect(displayLtr("")).toBe("");
    expect(displayUserText("דנה לוי")).toBe(`${FSI}דנה לוי${PDI}`);
    expect(displayUserText(null)).toBe("");
    expect(displayUserText(undefined)).toBe("");
  });
  it("stripDisplayIsolates removes every isolate character", () => {
    expect(stripDisplayIsolates(`${FSI}a${PDI} ${LRI}1–2${PDI} \u2067b\u2069`)).toBe("a 1–2 b");
  });
});

describe("isolateNumericRanges / displayDateRange", () => {
  it("isolates only the numeric spans", () => {
    expect(isolateNumericRanges("4–10 October 2026")).toBe(`${LRI}4–10${PDI} October 2026`);
    expect(isolateNumericRanges("at 18:00–19:00 today")).toBe(`at ${LRI}18:00–19:00${PDI} today`);
    expect(isolateNumericRanges("no range 2026")).toBe("no range 2026");
  });
  it("keeps the compact range text unchanged apart from isolates", () => {
    for (const lang of ["en", "he"] as const) {
      for (const [a, b] of [["2026-10-04", "2026-10-10"], ["2026-08-28", "2026-09-03"], ["2026-12-29", "2027-01-04"]]) {
        expect(stripDisplayIsolates(displayDateRange(a, b, lang))).toBe(formatISODateRangeCompact(a, b, lang));
      }
    }
    expect(displayDateRange("2026-10-04", "2026-10-10", "en")).toContain(`${LRI}4–10${PDI}`);
  });
});
