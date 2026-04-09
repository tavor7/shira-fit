import { createElement } from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { toISODateLocal } from "../lib/isoDate";
import type { DatePickerFieldProps } from "./DatePickerField.types";
import { useI18n } from "../context/I18nContext";

export function DatePickerField({ label, value, onChange, minimumDate, maximumDate }: DatePickerFieldProps) {
  const { isRTL } = useI18n();
  const min = minimumDate ? toISODateLocal(minimumDate) : undefined;
  const max = maximumDate ? toISODateLocal(maximumDate) : undefined;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      {createElement("input", {
        type: "date",
        value: value || "",
        min,
        max,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
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
