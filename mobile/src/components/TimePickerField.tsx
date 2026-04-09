import { useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

export type TimePickerFieldProps = {
  label: string;
  /** "HH:MM" (24h) */
  value: string;
  onChange: (hhmm: string) => void;
};

function parseHHMM(v: string): { hh: number; mm: number } | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = Math.max(0, Math.min(23, parseInt(m[1] ?? "", 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2] ?? "", 10)));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { hh, mm };
}

function toHHMM(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function toPickerDate(v: string): Date {
  const now = new Date();
  const p = parseHHMM(v);
  if (!p) return now;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(p.hh, p.mm, 0, 0);
  return d;
}

export function TimePickerField({ label, value, onChange }: TimePickerFieldProps) {
  const { language, isRTL } = useI18n();
  const [androidOpen, setAndroidOpen] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => toPickerDate(value));

  useEffect(() => {
    setIosDraft(toPickerDate(value));
  }, [value]);

  const display = useMemo(() => {
    const p = parseHHMM(value);
    if (!p) return language === "he" ? "בחרו שעה" : "Choose time";
    return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
  }, [value, language]);

  if (Platform.OS === "android") {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
        <Pressable onPress={() => setAndroidOpen(true)} style={({ pressed }) => [styles.touch, pressed && styles.touchPressed]}>
          <Text style={[styles.touchText, isRTL && styles.rtlTextLight]} numberOfLines={1} ellipsizeMode="tail">
            {display}
          </Text>
          <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text>
        </Pressable>
        {androidOpen ? (
          <DateTimePicker
            value={toPickerDate(value)}
            mode="time"
            is24Hour
            display="default"
            onChange={(event: DateTimePickerEvent, date?: Date) => {
              setAndroidOpen(false);
              if (event.type === "set" && date) onChange(toHHMM(date));
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
        <Text style={[styles.touchText, isRTL && styles.rtlTextLight]} numberOfLines={1} ellipsizeMode="tail">
          {display}
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
                  onChange(toHHMM(iosDraft));
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
              mode="time"
              is24Hour
              display="spinner"
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
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  touchPressed: { opacity: 0.92 },
  touchText: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "700", color: theme.colors.text },
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

