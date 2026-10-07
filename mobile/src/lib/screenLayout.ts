/**
 * Screen layout system (Phase 4B): one gutter scale and three content widths.
 *
 * - Gutter: the horizontal page padding, by viewport width (phones 16, tablets 24, desktop 32).
 * - Content width, by what the screen shows:
 *     narrow   — forms, account/settings, focused single-column content
 *     standard — lists and detail screens
 *     wide     — dashboards, reports and calendar screens (the 7-day grid needs ~940px)
 *   On wider viewports the content is centred inside the scroll area, so wheel/touch scrolling
 *   still works across the whole window.
 * - Bottom chrome: what sits at the bottom of the viewport (contact footer, in-screen bars such as
 *   the session prev/next bar, the floating accessibility button on web). Exactly one element — the
 *   bottom-most — applies the device safe-area inset; the floating button stacks above the rest.
 *
 * Pure functions only (unit-tested); see hooks/useScreenLayout.ts and context/BottomChromeContext.tsx.
 */
import { theme } from "../theme";

export type ContentWidth = "narrow" | "standard" | "wide";

export const LAYOUT = {
  /** Viewport widths where the gutter steps up. */
  breakpoints: { tablet: 600, desktop: 1024 },
  gutter: { phone: theme.spacing.md, tablet: theme.spacing.lg, desktop: theme.spacing.xl },
  /** Maximum width of the content itself (gutters are added around it). */
  maxContentWidth: { narrow: 560, standard: 800, wide: 1200 } as Record<ContentWidth, number>,
  /** Space between the end of scrollable content and whatever sits below it. */
  contentEndSpacing: theme.spacing.lg,
  /** Floating accessibility button (web): size and its distance from the chrome below it / the side. */
  fab: { size: 46, gap: theme.spacing.md, sideInset: 20 },
} as const;

export function screenGutter(viewportWidth: number): number {
  if (viewportWidth >= LAYOUT.breakpoints.desktop) return LAYOUT.gutter.desktop;
  if (viewportWidth >= LAYOUT.breakpoints.tablet) return LAYOUT.gutter.tablet;
  return LAYOUT.gutter.phone;
}

/** Horizontal frame for a screen's content: centred, capped, with the gutter as padding. */
export function screenContentFrame(viewportWidth: number, width: ContentWidth) {
  const gutter = screenGutter(viewportWidth);
  return {
    paddingHorizontal: gutter,
    /** Includes the gutters (React Native web uses border-box sizing). */
    maxWidth: LAYOUT.maxContentWidth[width] + gutter * 2,
  };
}

export type BottomChromeState = {
  /** Height of the contact footer when it is shown, else 0. It already includes the safe-area inset. */
  footerHeight: number;
  /** Sum of in-screen bottom bars (e.g. the session prev/next bar) currently mounted. */
  barsHeight: number;
  /** Device bottom safe-area inset (home indicator), 0 on most desktop/Android browsers. */
  safeAreaBottom: number;
  /** True where the floating accessibility button is shown (web). */
  fabVisible: boolean;
};

/** Who applies the safe-area inset: the footer when shown, otherwise the bottom-most bar, otherwise the scroll content. */
export function barBottomInset(state: Pick<BottomChromeState, "footerHeight" | "safeAreaBottom">, minimum: number): number {
  return state.footerHeight > 0 ? minimum : Math.max(state.safeAreaBottom, minimum);
}

/** Distance of the floating accessibility button from the viewport bottom: above every chrome element. */
export function fabBottomOffset(state: BottomChromeState): number {
  const below = state.footerHeight > 0 ? state.footerHeight : state.safeAreaBottom;
  return below + state.barsHeight + LAYOUT.fab.gap;
}

/**
 * Bottom padding for scrollable screen content, so its last element can scroll fully into view:
 * clear of the floating button (web) and, when nothing else sits below, of the safe area.
 * The footer and bars are laid out below the scroll area, so they need no extra clearance.
 */
export function scrollContentBottomPadding(state: BottomChromeState): number {
  const fab = state.fabVisible ? LAYOUT.fab.size + LAYOUT.fab.gap : 0;
  const safe = state.footerHeight > 0 || state.barsHeight > 0 ? 0 : state.safeAreaBottom;
  return LAYOUT.contentEndSpacing + fab + safe;
}

/** Distance of toasts from the viewport bottom: above the footer/bars and above the floating button's band. */
export function toastBottomOffset(state: BottomChromeState): number {
  return fabBottomOffset(state) + (state.fabVisible ? LAYOUT.fab.size + LAYOUT.fab.gap : 0);
}
