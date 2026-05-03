/**
 * Shira Fit — minimal dark UI: layered greys, one crisp CTA, generous radius.
 * (Inspired by 2025 dark-mode patterns: soft blacks, intentional contrast, calm density.)
 */
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
