import type { CSSProperties } from "react";
import { theme } from "../theme";

export function webFormNativeInputStyle(
  isRTL: boolean,
  appearance: "standalone" | "embedded" | "auth" = "standalone"
): CSSProperties {
  const embedded = appearance === "embedded";
  const auth = appearance === "auth";
  const base: CSSProperties = {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    margin: 0,
    height: embedded ? 44 : 48,
    minHeight: embedded ? 44 : 48,
    maxHeight: embedded ? 44 : 48,
    padding: "11px 12px",
    fontSize: 16,
    lineHeight: "22px",
    fontWeight: auth ? 500 : 700,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: auth ? theme.colors.borderInput : theme.colors.borderMuted,
    backgroundColor: embedded ? theme.colors.surface : theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    fontVariantNumeric: "tabular-nums",
    colorScheme: "dark",
    outline: "none",
    cursor: "pointer",
    touchAction: "manipulation",
    textAlign: isRTL ? "right" : "left",
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "textfield",
    overflow: "hidden",
  };
  return base;
}
