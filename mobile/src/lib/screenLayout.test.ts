import {
  LAYOUT,
  barBottomInset,
  fabBottomOffset,
  fullBleedInnerPadding,
  screenContentFrame,
  screenGutter,
  scrollContentBottomPadding,
  toastBottomOffset,
  type BottomChromeState,
} from "./screenLayout";

describe("screenGutter", () => {
  it.each([
    [320, 16], [393, 16], [599, 16],
    [600, 24], [768, 24], [1023, 24],
    [1024, 32], [1440, 32], [2560, 32],
  ])("%ipx → %ipx", (vw, gutter) => {
    expect(screenGutter(vw)).toBe(gutter);
  });
});

describe("screenContentFrame", () => {
  it("caps content at the category width plus gutters", () => {
    expect(screenContentFrame(1440, "narrow")).toEqual({ paddingHorizontal: 32, maxWidth: 560 + 64 });
    expect(screenContentFrame(1440, "standard")).toEqual({ paddingHorizontal: 32, maxWidth: 800 + 64 });
    expect(screenContentFrame(1440, "wide")).toEqual({ paddingHorizontal: 32, maxWidth: 1200 + 64 });
  });
  it("leaves phones full-width with the phone gutter", () => {
    const f = screenContentFrame(393, "wide");
    expect(f.paddingHorizontal).toBe(16);
    expect(f.maxWidth).toBeGreaterThan(393);
  });
  it("orders the widths narrow < standard < wide", () => {
    const w = LAYOUT.maxContentWidth;
    expect(w.narrow).toBeLessThan(w.standard);
    expect(w.standard).toBeLessThan(w.wide);
  });
  it("fits the 7-column week calendar (7×124 + 6×12) inside the wide width", () => {
    expect(7 * 124 + 6 * 12).toBeLessThanOrEqual(LAYOUT.maxContentWidth.wide);
  });
});

const base: BottomChromeState = { footerHeight: 0, barsHeight: 0, safeAreaBottom: 0, fabVisible: true };
const fab = LAYOUT.fab.size + LAYOUT.fab.gap;

describe("fullBleedInnerPadding", () => {
  it("uses the gutter while the content column fills the viewport", () => {
    expect(fullBleedInnerPadding(393, "standard")).toBe(16);
    expect(fullBleedInnerPadding(800, "standard")).toBe(24);
  });
  it("lines bar contents up with a centred column on wide viewports", () => {
    expect(fullBleedInnerPadding(1440, "standard")).toBe(320);
    expect(fullBleedInnerPadding(1440, "narrow")).toBe(440);
  });
});

describe("bottom chrome with a home indicator (34px inset)", () => {
  it("staff screen, no footer, no bars: content clears the button and the inset; button sits above the inset", () => {
    const s = { ...base, safeAreaBottom: 34 };
    expect(scrollContentBottomPadding(s)).toBe(LAYOUT.contentEndSpacing + fab + 34);
    expect(fabBottomOffset(s)).toBe(34 + LAYOUT.fab.gap);
  });
  it("athlete screen with footer: the footer owns the inset; nothing else adds it again", () => {
    const s = { ...base, safeAreaBottom: 34, footerHeight: 90 };
    expect(barBottomInset(s, 6)).toBe(6);
    expect(scrollContentBottomPadding(s)).toBe(LAYOUT.contentEndSpacing + fab);
    expect(fabBottomOffset(s)).toBe(90 + LAYOUT.fab.gap);
  });
  it("staff session detail with the prev/next bar: the bar owns the inset and the button stacks above it", () => {
    const s = { ...base, safeAreaBottom: 34, barsHeight: 48 };
    expect(barBottomInset(s, 6)).toBe(34);
    expect(fabBottomOffset(s)).toBe(34 + 48 + LAYOUT.fab.gap);
    expect(scrollContentBottomPadding(s)).toBe(LAYOUT.contentEndSpacing + fab);
  });
  it("athlete session detail: footer + bar + button never overlap", () => {
    const s = { ...base, safeAreaBottom: 34, footerHeight: 90, barsHeight: 48 };
    expect(barBottomInset(s, 6)).toBe(6);
    expect(fabBottomOffset(s)).toBe(90 + 48 + LAYOUT.fab.gap);
  });
});

describe("bottom chrome without a home indicator", () => {
  it("uses the minimum bar padding and no extra inset", () => {
    expect(barBottomInset(base, 6)).toBe(6);
    expect(fabBottomOffset(base)).toBe(LAYOUT.fab.gap);
  });
  it("native (no floating button) only keeps the end spacing", () => {
    expect(scrollContentBottomPadding({ ...base, fabVisible: false })).toBe(LAYOUT.contentEndSpacing);
  });
});

describe("toastBottomOffset", () => {
  it("places toasts above the footer, the bars and the floating button", () => {
    const s = { ...base, safeAreaBottom: 34, footerHeight: 90, barsHeight: 48 };
    expect(toastBottomOffset(s)).toBe(fabBottomOffset(s) + LAYOUT.fab.size + LAYOUT.fab.gap);
    expect(toastBottomOffset(s)).toBeGreaterThan(90 + 48);
  });
  it("without a floating button (native) sits just above the chrome", () => {
    expect(toastBottomOffset({ ...base, fabVisible: false, safeAreaBottom: 34 })).toBe(34 + LAYOUT.fab.gap);
  });
});
