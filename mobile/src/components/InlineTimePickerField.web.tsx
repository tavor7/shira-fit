import { createElement, type ChangeEvent } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { webFormNativeInputStyle } from "../lib/formNativeInput.web";
import { parseHHMM } from "../lib/timePickerUtils";
import type { TimePickerFieldProps } from "./TimePickerField";

export function InlineTimePickerField({
  label,
  value,
  onChange,
  labelTone = "form",
  appearance = "standalone",
}: TimePickerFieldProps) {
  const { isRTL } = useI18n();
  const sectionLabel = labelTone === "section";
  const embedded = appearance === "embedded";
  const parsed = parseHHMM(value);
  const inputValue = parsed ? `${String(parsed.hh).padStart(2, "0")}:${String(parsed.mm).padStart(2, "0")}` : "08:00";

  return (
    <View style={[styles.wrap, embedded && styles.wrapEmbedded]}>
      <Text style={[sectionLabel ? styles.labelSection : styles.labelForm, isRTL && styles.rtlText]}>{label}</Text>
      <View style={styles.inputFrame}>
        {createElement("input", {
          type: "time",
          value: inputValue,
          "aria-label": label,
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            if (next) onChange(next);
          },
          style: webFormNativeInputStyle(isRTL, appearance),
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", minWidth: 0 },
  wrapEmbedded: { marginTop: 0 },
  labelForm: { marginBottom: 6, fontWeight: "700", color: theme.colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  labelSection: {
    marginBottom: 8,
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  rtlText: { textAlign: "right" },
  inputFrame: { alignSelf: "stretch" },
});
