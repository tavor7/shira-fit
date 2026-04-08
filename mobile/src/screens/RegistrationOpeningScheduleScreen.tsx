import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";

const WEEKDAYS: { id: number; label: string }[] = [
  { id: 0, label: "Sunday" },
  { id: 1, label: "Monday" },
  { id: 2, label: "Tuesday" },
  { id: 3, label: "Wednesday" },
  { id: 4, label: "Thursday" },
  { id: 5, label: "Friday" },
  { id: 6, label: "Saturday" },
];

function isValidHHMM(s: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

export default function RegistrationOpeningScheduleScreen() {
  const [weekday, setWeekday] = useState<number>(4);
  const [time, setTime] = useState<string>("08:00");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { language, t, isRTL } = useI18n();

  const weekdayLabel = useMemo(() => WEEKDAYS.find((w) => w.id === weekday)?.label ?? "—", [weekday]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_registration_opening_schedule");
    setLoading(false);
    if (error) return;
    const row = (data as { weekday: number; time_str: string }[] | null)?.[0];
    if (row) {
      setWeekday(row.weekday);
      setTime(row.time_str);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const timeStr = time.trim();
    if (!isValidHHMM(timeStr)) {
      Alert.alert(
        language === "he" ? "שעה לא תקינה" : "Invalid time",
        language === "he" ? "השתמשו בפורמט HH:MM (24 שעות), לדוגמה 08:00." : "Use HH:MM in 24-hour format, e.g. 08:00.",
      );
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.rpc("set_registration_opening_schedule", {
      p_weekday: weekday,
      p_time: timeStr,
    });
    setSaving(false);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(t("common.failed"), data?.error ?? "Unknown error");
      return;
    }
    Alert.alert(
      t("common.saved"),
      language === "he"
        ? `פתיחת הרשמה שבועית נקבעה ל-${weekdayLabel} בשעה ${timeStr} (UTC).`
        : `Weekly opening set to ${weekdayLabel} at ${timeStr} (UTC).`,
    );
  }

  return (
    <View style={styles.screen}>
      <ManagerOverviewTabs />
      <Text style={[styles.title, isRTL && styles.rtlText]}>
        {language === "he" ? "פתיחת הרשמה" : "Registration opening"}
      </Text>
      <Text style={[styles.hint, isRTL && styles.rtlText]}>
        {language === "he"
          ? "אימונים של שבוע הבא נשארים סגורים עד זמן הפתיחה. בזמן הפתיחה, כל האימונים שאינם מוסתרים בשבוע הבא (א׳–ש׳) ייפתחו להרשמה. השעה נשמרת כ-UTC."
          : "Next-week sessions stay closed until the opening time. At the opening, all non-hidden sessions in next week (Sun–Sat) become open for registration. Time is stored as UTC."}
      </Text>

      <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "יום" : "Day"}</Text>
      <View style={styles.row}>
        {WEEKDAYS.map((d) => (
          <Pressable
            key={d.id}
            onPress={() => setWeekday(d.id)}
            style={({ pressed }) => [
              styles.dayChip,
              d.id === weekday ? styles.dayChipOn : styles.dayChipOff,
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={[styles.dayTxt, d.id === weekday ? styles.dayTxtOn : styles.dayTxtOff]}>{d.label.slice(0, 3)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "שעה (UTC)" : "Time (UTC)"}</Text>
      <TextInput
        value={time}
        onChangeText={setTime}
        placeholder="08:00"
        placeholderTextColor={theme.colors.placeholderOnLight}
        style={styles.input}
        autoCapitalize="none"
      />

      <PrimaryButton
        label={loading ? t("common.loading") : t("common.save")}
        onPress={save}
        loading={saving}
        loadingLabel={t("common.loading")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  hint: { marginTop: 8, color: theme.colors.textMuted, lineHeight: 18 },
  label: { marginTop: theme.spacing.md, fontWeight: "700", color: theme.colors.text },
  rtlText: { textAlign: "right" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  dayChip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: theme.radius.full, borderWidth: 1 },
  dayChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  dayChipOff: { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.borderMuted },
  dayTxt: { fontWeight: "900", fontSize: 12 },
  dayTxtOn: { color: theme.colors.ctaText },
  dayTxtOff: { color: theme.colors.text },
  input: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
    marginBottom: theme.spacing.md,
  },
});

