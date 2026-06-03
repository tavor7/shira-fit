import { createElement, type ChangeEvent, type CSSProperties } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { parseHHMM } from "../lib/timePickerUtils";
import type { TimePickerFieldProps } from "./TimePickerField";

export function InlineTimePickerField({ label, value, onChange }: TimePickerFieldProps) {
  const { isRTL } = useI18n();
  const parsed = parseHHMM(value);
  const inputValue = parsed ? `${String(parsed.hh).padStart(2, "0")}:${String(parsed.mm).padStart(2, "0")}` : "08:00";

  const inputStyle: CSSProperties = {
    width: "100%",
    minHeight: 52,
    padding: "12px 14px",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    outline: "none",
    boxSizing: "border-box",
    colorScheme: "dark",
    cursor: "pointer",
    touchAction: "manipulation",
    textAlign: isRTL ? "right" : "left",
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      <View style={styles.inputFrame}>
        {createElement("input", {
          type: "time",
          value: inputValue,
          "aria-label": label,
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            if (next) onChange(next);
          },
          style: inputStyle,
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", minWidth: 0 },
  label: {
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
