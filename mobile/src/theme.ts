/**
 * Shira Fit — minimal dark UI: layered greys, one crisp CTA, generous radius.
 * (Inspired by 2025 dark-mode patterns: soft blacks, intentional contrast, calm density.)
 */
import { Easing } from "react-native";

export const theme = {
  colors: {
    /** Near-black canvas */
    background: "#0a0a0b",
    /** Screens / chrome */
    backgroundAlt: "#121214",
    /** Cards, columns, sheets */
    surface: "#18181c",
    surfaceElevated: "#222228",
    /** Legacy aliases — map to surfaces */
    primary: "#18181c",
    primaryLight: "#222228",
    accent: "#2a2a32",
    accentLight: "#32323b",
    /** Primary tap target: light pill on dark */
    cta: "#f4f4f5",
    ctaText: "#0a0a0b",
    /** Soft paper for form fields (readable, not harsh white) */
    white: "#f0f0f3",
    text: "#f4f4f5",
    /** Alert strip subject / lead (readable on small screens; still distinct from `text`) */
    alertSubject: "#d0d0d8",
    textMuted: "#a1a1aa",
    textSoft: "#71717a",
    border: "#2e2e36",
    borderMuted: "#25252c",
    borderInput: "#3f3f48",
    /** On light-ish inputs */
    textOnLight: "#0a0a0b",
    textMutedOnLight: "#52525b",
    textSoftOnLight: "#71717a",
    placeholderOnLight: "#a1a1aa",
    error: "#ef4444",
    errorBg: "#2a1515",
    errorBorder: "#7f1d1d",
    success: "#22c55e",
    successBg: "#142818",
    warning: "#fbbf24",
    warningBg: "rgba(245,158,11,0.14)",
    warningBorder: "rgba(245,158,11,0.4)",
    info: "#93c5fd",
    infoBg: "rgba(96,165,250,0.14)",
    infoBorder: "rgba(96,165,250,0.4)",
    /** Studio calendar note kinds — teal/violet so notes never read as “live session” green. */
    calendarNoteHoliday: "#2dd4bf",
    calendarNoteInfo: "#c084fc",
  },
  spacing: {
    xs: 6,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 10,
    md: 14,
    lg: 20,
    xl: 28,
    full: 9999,
  },
  typography: {
    display: {
      fontSize: 22,
      fontWeight: "800" as const,
      lineHeight: 25,
      letterSpacing: 0.2,
    },
    headline: {
      fontSize: 18,
      fontWeight: "800" as const,
      lineHeight: 22,
      letterSpacing: 0.2,
    },
    title: {
      fontSize: 16,
      fontWeight: "700" as const,
      lineHeight: 20,
      letterSpacing: 0.2,
    },
    body: {
      fontSize: 16,
      fontWeight: "500" as const,
      lineHeight: 23,
      letterSpacing: 0.15,
    },
    label: {
      fontSize: 12,
      fontWeight: "700" as const,
      lineHeight: 14,
      letterSpacing: 0.3,
    },
    caption: {
      fontSize: 13,
      fontWeight: "600" as const,
      lineHeight: 18,
      letterSpacing: 0.15,
    },
  },
  overlay: {
    backdrop: "rgba(0,0,0,0.55)",
  },
  motion: {
    fast: 200,
    normal: 280,
    slow: 360,
    /** Cap on staggered-list entrance index — items beyond this animate together. */
    maxStaggerIndex: 8,
    easeOut: Easing.out(Easing.cubic),
    easeIn: Easing.in(Easing.cubic),
    /** Matches PrimaryButton's success checkmark pop. */
    springOvershoot: Easing.out(Easing.back(1.4)),
    /** Matches AppModal's popover pop-in. */
    popoverSpring: Easing.out(Easing.back(1.15)),
  },
  fontWeights: {
    normal: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
    heavy: "800" as const,
  },
  /** Dynamic type: cap scaling on dense chrome so headers and pills stay usable. */
  a11y: {
    chromeMaxFontMultiplier: 1.35,
    bodyMaxFontMultiplier: 1.6,
  },
};

export type TypographyVariant = keyof typeof theme.typography;
