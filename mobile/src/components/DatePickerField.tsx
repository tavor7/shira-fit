import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { theme } from "../theme";
import { parseISODateLocal, toISODateLocal, formatISODateShortDisplay, isValidISODateString } from "../lib/isoDate";
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
  const [androidOpen, setAndroidOpen] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => parseISODateLocal(value) ?? new Date());
  const { language, isRTL } = useI18n();
  const embedded = appearance === "embedded";
  const auth = appearance === "auth";

  useEffect(() => {
    const p = parseISODateLocal(value);
    if (p) setIosDraft(p);
  }, [value]);

  const displayText = isValidISODateString(value)
    ? formatISODateShortDisplay(value, language)
    : language === "he"
      ? "בחרו תאריך"
      : "Choose date";
  const hasValue = isValidISODateString(value);
  const pickerValue = parseISODateLocal(value) ?? new Date();

  if (Platform.OS === "android") {
    return (
      <View style={[styles.wrap, embedded && styles.wrapEmbedded, auth && styles.wrapAuth]}>
        <Text style={[styles.label, auth && styles.labelAuth, isRTL && styles.rtlText]}>{label}</Text>
        <Pressable
          onPress={() => setAndroidOpen(true)}
          style={({ pressed }) => [
            styles.touch,
            embedded && styles.touchEmbedded,
            auth && styles.touchAuth,
            hasValue && !embedded && !auth && styles.touchActive,
            pressed && styles.touchPressed,
          ]}
        >
          <Text
            style={[
              styles.touchText,
              auth && styles.touchTextAuth,
              !hasValue && styles.touchTextPlaceholder,
              isRTL && styles.rtlTextLight,
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {displayText}
          </Text>
          {!auth ? <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text> : null}
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
    <View style={[styles.wrap, embedded && styles.wrapEmbedded, auth && styles.wrapAuth]}>
      <Text style={[styles.label, auth && styles.labelAuth, isRTL && styles.rtlText]}>{label}</Text>
      <Pressable
        onPress={() => setIosOpen(true)}
        style={({ pressed }) => [
          styles.touch,
          embedded && styles.touchEmbedded,
          auth && styles.touchAuth,
          hasValue && !embedded && !auth && styles.touchActive,
          pressed && styles.touchPressed,
        ]}
      >
        <Text
          style={[
            styles.touchText,
            auth && styles.touchTextAuth,
            !hasValue && styles.touchTextPlaceholder,
            isRTL && styles.rtlTextLight,
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayText}
        </Text>
        {!auth ? <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text> : null}
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
  // Critical: allow this field to shrink inside rows without overflowing/overlapping.
  wrap: { marginTop: theme.spacing.sm, alignSelf: "stretch", minWidth: 0, width: "100%", maxWidth: "100%" },
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
  touch: {
    alignSelf: "stretch",
    minWidth: 0,
    width: "100%",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  touchEmbedded: {
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 0,
    paddingVertical: 4,
    minHeight: 44,
  },
  touchAuth: {
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    minHeight: 48,
  },
  touchActive: {
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.surface,
  },
  touchPressed: { opacity: 0.92 },
  touchText: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "700", color: theme.colors.text },
  touchTextAuth: { fontWeight: "500", lineHeight: 22 },
  touchTextPlaceholder: { color: theme.colors.textMuted, fontWeight: "800" },
  rtlTextLight: { textAlign: "right" },
  chev: { fontSize: 10, color: theme.colors.textMuted },
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
