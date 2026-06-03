import type { CSSProperties } from "react";
import { theme } from "../theme";

export function webFormNativeInputStyle(
  isRTL: boolean,
  appearance: "standalone" | "embedded" | "auth" = "standalone"
): CSSProperties {
  const embedded = appearance === "embedded";
  const auth = appearance === "auth";
  const base: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    height: auth ? 48 : embedded ? 44 : 48,
    maxHeight: auth ? 48 : undefined,
    minHeight: embedded ? 44 : 48,
    padding: embedded ? "4px 0" : auth ? "12px 16px" : "12px 14px",
    fontSize: 16,
    lineHeight: auth ? "22px" : undefined,
    fontWeight: auth ? 500 : 700,
    borderRadius: embedded ? 0 : theme.radius.md,
    borderWidth: embedded ? 0 : 1,
    borderStyle: "solid",
    borderColor: auth ? theme.colors.borderInput : theme.colors.borderMuted,
    backgroundColor: embedded ? "transparent" : auth ? theme.colors.surfaceElevated : theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontVariantNumeric: "tabular-nums",
    colorScheme: "dark",
    outline: "none",
    cursor: "pointer",
    touchAction: "manipulation",
    textAlign: isRTL ? "right" : "left",
    appearance: auth ? "none" : undefined,
    WebkitAppearance: auth ? "none" : undefined,
  };
  return base;
}
