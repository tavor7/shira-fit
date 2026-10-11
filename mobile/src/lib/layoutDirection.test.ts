import { platformLayoutIsRTL, shouldFlipRows } from "./layoutDirection";

describe("shouldFlipRows (truth table)", () => {
  // [platform, ui RTL, native I18nManager.isRTL, expected flip]
  const table: [string, boolean, boolean, boolean][] = [
    // Web: <html dir> follows the UI language, so the browser always mirrors for us.
    ["web", false, false, false],
    ["web", true, false, false],
    ["web", true, true, false],
    ["web", false, true, false],
    // Native before forceRTL has taken effect (no restart yet): flip manually for Hebrew.
    ["ios", true, false, true],
    ["android", true, false, true],
    // Native after restart with RTL applied: the platform mirrors, so do not flip again.
    ["ios", true, true, false],
    // Native English while the platform is still RTL (switched to English, no restart yet): flip back to LTR.
    ["ios", false, true, true],
    ["ios", false, false, false],
  ];
  it.each(table)("%s ui=%p native=%p → %p", (os, ui, native, expected) => {
    expect(shouldFlipRows(os, ui, native)).toBe(expected);
  });
});

describe("platformLayoutIsRTL", () => {
  it("web follows the UI language, native follows I18nManager", () => {
    expect(platformLayoutIsRTL("web", true, false)).toBe(true);
    expect(platformLayoutIsRTL("web", false, true)).toBe(false);
    expect(platformLayoutIsRTL("ios", false, true)).toBe(true);
    expect(platformLayoutIsRTL("android", true, false)).toBe(false);
  });
});
