import { createElement } from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { toISODateLocal } from "../lib/isoDate";
import { webFormNativeInputStyle } from "../lib/formNativeInput.web";
import type { DatePickerFieldProps } from "./DatePickerField.types";
import { useI18n } from "../context/I18nContext";

export function DatePickerField({
  label,
  value,
  onChange,
  minimumDate,
  maximumDate,
  appearance = "standalone",
}: DatePickerFieldProps) {
  const { isRTL } = useI18n();
  const embedded = appearance === "embedded";
  const auth = appearance === "auth";
  const min = minimumDate ? toISODateLocal(minimumDate) : undefined;
  const max = maximumDate ? toISODateLocal(maximumDate) : undefined;

  return (
    <View style={[styles.wrap, embedded && styles.wrapEmbedded, auth && styles.wrapAuth]}>
      <Text style={[styles.label, auth && styles.labelAuth, isRTL && styles.rtlText]}>{label}</Text>
      {createElement("input", {
        type: "date",
        value: value || "",
        min,
        max,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        onKeyDown: (e: { preventDefault: () => void }) => e.preventDefault(),
        onPaste: (e: { preventDefault: () => void }) => e.preventDefault(),
        onBeforeInput: (e: { preventDefault: () => void }) => e.preventDefault(),
        autoComplete: "off",
        style: webFormNativeInputStyle(isRTL, appearance),
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm, alignSelf: "stretch", minWidth: 0 },
  wrapEmbedded: { marginTop: 0 },
  wrapAuth: { marginTop: 0, marginBottom: theme.spacing.sm },
  label: { marginBottom: 6, fontWeight: "700", color: theme.colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  labelAuth: {
    marginBottom: theme.spacing.xs,
    marginTop: 0,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: theme.colors.textSoft,
  },
  rtlText: { textAlign: "right" },
});
