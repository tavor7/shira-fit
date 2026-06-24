import { Platform, StyleSheet, Text, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { dateToHHMM, toPickerDate } from "../lib/timePickerUtils";
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

  return (
    <View style={[styles.wrap, embedded && styles.wrapEmbedded]}>
      <Text style={[sectionLabel ? styles.labelSection : styles.labelForm, isRTL && styles.rtlText]}>{label}</Text>
      <View style={[styles.pickerShell, embedded && styles.pickerShellEmbedded]}>
        <DateTimePicker
          value={toPickerDate(value)}
          mode="time"
          is24Hour
          display={Platform.OS === "ios" ? "spinner" : "spinner"}
          onChange={(_, date?: Date) => {
            if (date) onChange(dateToHHMM(date));
          }}
          style={styles.picker}
        />
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
  pickerShell: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    minHeight: Platform.OS === "ios" ? 196 : 160,
  },
  pickerShellEmbedded: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    minHeight: Platform.OS === "ios" ? 168 : 140,
  },
  picker: {
    alignSelf: "stretch",
    width: "100%",
  },
});
