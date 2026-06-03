import type { CSSProperties } from "react";
import { theme } from "../theme";

export function webFormNativeInputStyle(isRTL: boolean, embedded = false): CSSProperties {
  const base: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minHeight: embedded ? 44 : 48,
    padding: embedded ? "4px 0" : "12px 14px",
    fontSize: 16,
    fontWeight: 700,
    borderRadius: embedded ? 0 : theme.radius.md,
    borderWidth: embedded ? 0 : 1,
    borderStyle: "solid",
    borderColor: theme.colors.borderMuted,
    backgroundColor: embedded ? "transparent" : theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontVariantNumeric: "tabular-nums",
    colorScheme: "dark",
    outline: "none",
    cursor: "pointer",
    touchAction: "manipulation",
    textAlign: isRTL ? "right" : "left",
  };
  return base;
}
