import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { theme } from "../theme";
import { parseISODateLocal, toISODateLocal, formatISODateShortDisplay, isValidISODateString } from "../lib/isoDate";
import type { DatePickerFieldProps } from "./DatePickerField.types";
import { useI18n } from "../context/I18nContext";

export function DatePickerField({ label, value, onChange, minimumDate, maximumDate }: DatePickerFieldProps) {
  const [androidOpen, setAndroidOpen] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => parseISODateLocal(value) ?? new Date());
  const { language, isRTL } = useI18n();

  useEffect(() => {
    const p = parseISODateLocal(value);
    if (p) setIosDraft(p);
  }, [value]);

  const displayText = isValidISODateString(value)
    ? formatISODateShortDisplay(value, language)
    : language === "he"
      ? "בחרו תאריך"
      : "Choose date";
  const pickerValue = parseISODateLocal(value) ?? new Date();

  if (Platform.OS === "android") {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
        <Pressable
          onPress={() => setAndroidOpen(true)}
          style={({ pressed }) => [styles.touch, pressed && styles.touchPressed]}
        >
          <Text
            style={[styles.touchText, isRTL && styles.rtlTextLight]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {displayText}
          </Text>
          <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text>
        </Pressable>
        {androidOpen ? (
          <DateTimePicker
            value={pickerValue}
            mode="date"
            display="default"
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            onChange={(event: DateTimePickerEvent, date?: Date) => {
              setAndroidOpen(false);
              if (event.type === "set" && date) {
                onChange(toISODateLocal(date));
              }
            }}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      <Pressable onPress={() => setIosOpen(true)} style={({ pressed }) => [styles.touch, pressed && styles.touchPressed]}>
        <Text
          style={[styles.touchText, isRTL && styles.rtlTextLight]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayText}
        </Text>
        <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text>
      </Pressable>
      <Modal visible={iosOpen} transparent animationType="slide" onRequestClose={() => setIosOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFlex} onPress={() => setIosOpen(false)} accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"} />
          <View style={styles.sheet}>
            <View style={styles.toolbar}>
              <Pressable onPress={() => setIosOpen(false)} hitSlop={12} style={styles.tbBtn}>
                <Text style={styles.tbMuted}>{language === "he" ? "ביטול" : "Cancel"}</Text>
              </Pressable>
              <Text style={styles.tbTitle} numberOfLines={1}>
                {label}
              </Text>
              <Pressable
                onPress={() => {
                  onChange(toISODateLocal(iosDraft));
                  setIosOpen(false);
                }}
                hitSlop={12}
                style={styles.tbBtn}
              >
                <Text style={styles.tbCta}>{language === "he" ? "אישור" : "Done"}</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={iosDraft}
              mode="date"
              display="spinner"
              minimumDate={minimumDate}
              maximumDate={maximumDate}
              onChange={(_, date) => {
                if (date) setIosDraft(date);
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm },
  label: { marginBottom: 6, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  rtlText: { textAlign: "right" },
  touch: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.white,
    overflow: "hidden",
  },
  touchPressed: { opacity: 0.92 },
  touchText: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  rtlTextLight: { textAlign: "right" },
  chev: { fontSize: 10, color: theme.colors.textMutedOnLight },
  chevLtr: { marginLeft: 8 },
  chevRtl: { marginRight: 8 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdropFlex: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: theme.spacing.lg,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  tbBtn: { minWidth: 64 },
  tbMuted: { fontSize: 16, fontWeight: "600", color: theme.colors.textMuted },
  tbTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: theme.colors.text },
  tbCta: { fontSize: 16, fontWeight: "800", color: theme.colors.cta },
});
