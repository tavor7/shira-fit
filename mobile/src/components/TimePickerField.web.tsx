import { createElement } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { TimePickerFieldProps } from "./TimePickerField";

function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isWebKit = /WebKit/.test(ua);
  const isNotChrome = !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isWebKit && isNotChrome;
}

function normalizeHHMM(v: string): string {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return "";
  const hh = Math.max(0, Math.min(23, parseInt(m[1] ?? "", 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2] ?? "", 10)));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return "";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function TimePickerField({ label, value, onChange }: TimePickerFieldProps) {
  const { isRTL } = useI18n();
  const normalized = normalizeHHMM(value);
  const useTextFallback = isIOSSafari();

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      {createElement("input", {
        type: useTextFallback ? "text" : "time",
        value: useTextFallback ? value || "" : normalized,
        ...(useTextFallback ? {} : { step: 300 }),
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        placeholder: useTextFallback ? "HH:MM" : undefined,
        inputMode: useTextFallback ? ("numeric" as any) : undefined,
        autoComplete: "off",
        style: {
          width: "100%",
          boxSizing: "border-box" as const,
          minHeight: 48,
          padding: "12px 12px",
          fontSize: 16,
          borderRadius: theme.radius.md,
          border: `1px solid ${theme.colors.borderMuted}`,
          backgroundColor: theme.colors.surfaceElevated,
          color: theme.colors.text,
          fontFamily: "system-ui, -apple-system, sans-serif",
          textAlign: isRTL ? ("right" as const) : ("left" as const),
        },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm, alignSelf: "stretch", minWidth: 0 },
  label: { marginBottom: 6, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  rtlText: { textAlign: "right" },
});

