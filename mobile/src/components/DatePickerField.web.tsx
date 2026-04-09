import { createElement } from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { toISODateLocal } from "../lib/isoDate";
import type { DatePickerFieldProps } from "./DatePickerField.types";
import { useI18n } from "../context/I18nContext";

function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isWebKit = /WebKit/.test(ua);
  const isNotChrome = !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isWebKit && isNotChrome;
}

export function DatePickerField({ label, value, onChange, minimumDate, maximumDate }: DatePickerFieldProps) {
  const { isRTL } = useI18n();
  const min = minimumDate ? toISODateLocal(minimumDate) : undefined;
  const max = maximumDate ? toISODateLocal(maximumDate) : undefined;
  const useTextFallback = isIOSSafari();

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      {createElement("input", {
        type: useTextFallback ? "text" : "date",
        value: value || "",
        ...(useTextFallback ? {} : { min, max }),
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        placeholder: useTextFallback ? "YYYY-MM-DD" : undefined,
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
