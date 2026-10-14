import { MODAL_MIN_USABLE_HEIGHT, modalMaxHeight, type ModalHeightInput } from "./modalLayout";

const LG = 24;
const MD = 16;
const base = (o: Partial<ModalHeightInput>): ModalHeightInput => ({
  variant: "dialog",
  windowHeight: 800,
  pct: 0.85,
  insetTop: 0,
  insetBottom: 0,
  dialogPadding: LG,
  gap: MD,
  ...o,
});
// The historical formula (before the clamp), used to prove normal sizes did not change.
const legacy = (variant: ModalHeightInput["variant"], h: number, pct: number, insetBottom = 0) =>
  Math.max(220, Math.round(h * pct) - (variant === "sheet" ? insetBottom : variant === "dialog" ? LG * 2 : 0) - MD);

describe("modalMaxHeight", () => {
  it("is exactly the historical value whenever the window can hold it", () => {
    for (const h of [320, 375, 390, 568, 667, 800, 844, 1024, 1440]) {
      for (const [variant, pct] of [["dialog", 0.85], ["dialog", 0.92], ["dialog", 1], ["sheet", 0.8], ["sheet", 0.62], ["sheet", 0.88], ["popover", 0.88]] as const) {
        const want = legacy(variant, h, pct, 34);
        const got = modalMaxHeight(base({ variant, windowHeight: h, pct, insetBottom: 34 }));
        const room = variant === "dialog" ? h - LG * 2 - 34 : variant === "sheet" ? h : h;
        if (want <= room) expect(got).toBe(want);
      }
    }
  });

  it("never exceeds the room the backdrop leaves in a very short window (400% zoom, landscape phones)", () => {
    expect(modalMaxHeight(base({ windowHeight: 256 }))).toBe(256 - LG * 2); // was 220 > 208: clipped
    expect(modalMaxHeight(base({ windowHeight: 200 }))).toBe(200 - LG * 2);
    expect(modalMaxHeight(base({ windowHeight: 320 }))).toBe(Math.min(legacy("dialog", 320, 0.85), 320 - LG * 2));
    expect(modalMaxHeight(base({ variant: "sheet", windowHeight: 180, pct: 0.8 }))).toBe(180);
  });

  it("respects safe-area insets and keeps a usable minimum", () => {
    expect(modalMaxHeight(base({ windowHeight: 300, insetTop: 20, insetBottom: 34 }))).toBe(300 - LG * 2 - 20 - 34);
    expect(modalMaxHeight(base({ windowHeight: 120 }))).toBe(MODAL_MIN_USABLE_HEIGHT);
  });

  it("keeps an anchored popover inside the window", () => {
    expect(modalMaxHeight(base({ variant: "popover", pct: 0.88, windowHeight: 844, popoverTop: 60 }))).toBe(legacy("popover", 844, 0.88));
    expect(modalMaxHeight(base({ variant: "popover", pct: 0.88, windowHeight: 256, popoverTop: 60 }))).toBe(256 - 60 - 8);
    expect(modalMaxHeight(base({ variant: "popover", pct: 0.88, windowHeight: 844, popoverTop: 724 }))).toBe(844 - 724 - 8);
  });
});
