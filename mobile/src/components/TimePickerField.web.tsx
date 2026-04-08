import { createElement } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { TimePickerFieldProps } from "./TimePickerField";

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

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      {createElement("input", {
        type: "time",
        value: normalized,
        step: 300, // 5 minutes
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        style: {
          width: "100%",
          boxSizing: "border-box" as const,
          padding: 12,
          fontSize: 16,
          borderRadius: theme.radius.sm,
          border: `1px solid ${theme.colors.borderInput}`,
          backgroundColor: theme.colors.white,
          color: theme.colors.textOnLight,
          fontFamily: "system-ui, -apple-system, sans-serif",
          textAlign: isRTL ? ("right" as const) : ("left" as const),
        },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm },
  label: { marginBottom: 6, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  rtlText: { textAlign: "right" },
});

