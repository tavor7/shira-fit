import { createElement } from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { toISODateLocal } from "../lib/isoDate";
import type { DatePickerFieldProps } from "./DatePickerField.types";

export function DatePickerField({ label, value, onChange, minimumDate, maximumDate }: DatePickerFieldProps) {
  const min = minimumDate ? toISODateLocal(minimumDate) : undefined;
  const max = maximumDate ? toISODateLocal(maximumDate) : undefined;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {createElement("input", {
        type: "date",
        value: value || "",
        min,
        max,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        style: {
          width: "100%",
          boxSizing: "border-box" as const,
          padding: 12,
          fontSize: 16,
          borderRadius: theme.radius.md,
          border: `1px solid ${theme.colors.borderInput}`,
          backgroundColor: theme.colors.white,
          color: theme.colors.textOnLight,
          fontFamily: "system-ui, -apple-system, sans-serif",
        },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm },
  label: { marginBottom: 6, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
});
