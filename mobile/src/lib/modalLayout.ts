/** Smallest card height we still allow when the window is very short (keeps a title and one action visible; the rest scrolls). */
export const MODAL_MIN_USABLE_HEIGHT = 96;
/** Historical floor of the card height; it only applies while the window can actually hold it. */
const LEGACY_FLOOR = 220;
const POPOVER_BOTTOM_MARGIN = 8;
/** Below this window height, modals whose body already scrolls (pinned header + list) fall back to scrolling the whole card, so a short window (400% zoom, landscape phone) can never push the header, list and footer out of reach together. */
export const SHORT_WINDOW_HEIGHT = 380;

export type ModalHeightInput = {
  variant: "popover" | "sheet" | "dialog";
  windowHeight: number;
  /** Fraction of the window height (variant default or the caller's `maxHeightPct`). */
  pct: number;
  insetTop: number;
  insetBottom: number;
  /** Backdrop padding around a dialog (top and bottom each). */
  dialogPadding: number;
  /** Extra breathing room that has always been subtracted (theme.spacing.md). */
  gap: number;
  /** Popover only: the card's top edge in window coordinates (anchored under its trigger); it must end inside the window. */
  popoverTop?: number;
};

/**
 * Maximum card height of an AppModal. At normal window heights this is exactly the historical value
 * (`max(220, pct * height - chrome)`), so existing layouts do not move. When the window is too short to
 * hold that (a landscape phone, 400% browser zoom) the card is clamped to the room the backdrop really
 * leaves, so it can never extend past the visible area; whatever does not fit must scroll.
 */
export function modalMaxHeight(i: ModalHeightInput): number {
  const chrome = i.variant === "sheet" ? i.insetBottom : i.variant === "dialog" ? i.dialogPadding * 2 : 0;
  const legacy = Math.max(LEGACY_FLOOR, Math.round(i.windowHeight * i.pct) - chrome - i.gap);
  // Room the backdrop leaves for the card (dialog: padding + safe areas on both sides; sheet: below the top inset; popover: whole window).
  const available =
    i.variant === "dialog"
      ? i.windowHeight - i.dialogPadding * 2 - i.insetTop - i.insetBottom
      : i.variant === "sheet"
        ? i.windowHeight - i.insetTop
        : i.popoverTop != null
          ? i.windowHeight - i.popoverTop - POPOVER_BOTTOM_MARGIN
          : i.windowHeight;
  return Math.max(MODAL_MIN_USABLE_HEIGHT, Math.min(legacy, Math.floor(available)));
}

/**
 * Min height for a picker body (search field + list) that should feel roomy on normal screens (`preferred`) but must
 * still fit the card on a short window, otherwise the card clips the rows. Equal to `preferred` whenever the window
 * can hold it (card height = pct of the window, minus the header and padding in `chrome`).
 */
export function pickerBodyMinHeight(windowHeight: number, preferred: number, pct = 0.85, chrome = 72): number {
  return Math.max(120, Math.min(preferred, Math.floor(windowHeight * pct) - chrome));
}
