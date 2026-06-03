import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { supabase } from "../lib/supabase";
import { appLocale } from "../lib/appLocale";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { InlineTimePickerField } from "../components/InlineTimePickerField";
import { useI18n } from "../context/I18nContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import type { LanguageCode } from "../i18n/translations";

const WEEKDAY_IDS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Jan 7 2024 is a Sunday — anchor for weekday labels. */
function dateForWeekdayId(id: number): Date {
  return new Date(2024, 0, 7 + id);
}

function formatWeekdayShort(id: number, language: LanguageCode): string {
  return dateForWeekdayId(id).toLocaleDateString(appLocale(language), { weekday: "narrow" });
}

function formatWeekdayLong(id: number, language: LanguageCode): string {
  return dateForWeekdayId(id).toLocaleDateString(appLocale(language), { weekday: "long" });
}

export default function RegistrationOpeningScheduleScreen() {
  const [weekday, setWeekday] = useState<number>(4);
  const [time, setTime] = useState<string>("08:00");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { language, t, isRTL } = useI18n();

  const weekdayShort = useMemo(
    () => Object.fromEntries(WEEKDAY_IDS.map((id) => [id, formatWeekdayShort(id, language)])) as Record<number, string>,
    [language]
  );
  const weekdayLong = useMemo(
    () => Object.fromEntries(WEEKDAY_IDS.map((id) => [id, formatWeekdayLong(id, language)])) as Record<number, string>,
    [language]
  );

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
    const weekdayLabel = weekdayLong[weekday] ?? "—";
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
        ? `פתיחת הרשמה שבועית נקבעה ל-${weekdayLabel} בשעה ${timeStr} (שעון ישראל).`
        : `Weekly opening set to ${weekdayLabel} at ${timeStr} (Israel time).`,
    );
  }

  const previewDay = weekdayLong[weekday] ?? "—";
  const timeLabel = language === "he" ? "שעה (שעון ישראל)" : "Time (Israel)";
  const dayLabel = language === "he" ? "יום" : "Day";
  const previewEyebrow = language === "he" ? "לוח זמנים נוכחי" : "Current schedule";
  const previewMeta = language === "he" ? "שעון ישראל (הסטודיו)" : "Israel (studio) time";

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      <ManagerStudioSetupTabs />

      <Text style={[styles.title, isRTL && styles.rtlText]}>
        {language === "he" ? "פתיחת הרשמה" : "Registration opening"}
      </Text>
      <Text style={[styles.hint, isRTL && styles.rtlText]}>
        {language === "he"
          ? "אימונים של שבוע הבא נשארים סגורים עד זמן הפתיחה. בזמן הפתיחה, כל האימונים שאינם מוסתרים בשבוע הבא (א׳–ש׳) ייפתחו להרשמה."
          : "Next-week sessions stay closed until the opening time. At the opening, all non-hidden sessions in next week (Sun–Sat) become open for registration."}
      </Text>

      <View style={styles.card}>
        <View style={styles.section}>
          <Text style={[styles.sectionEyebrow, isRTL && styles.rtlText]}>{dayLabel}</Text>
          <View style={[styles.dayTrack, isRTL && styles.dayTrackRtl]}>
            {WEEKDAY_IDS.map((id) => {
              const on = id === weekday;
              return (
                <Pressable
                  key={id}
                  onPress={() => setWeekday(id)}
                  style={({ pressed }) => [
                    styles.dayBtn,
                    on && styles.dayBtnOn,
                    pressed && !on && styles.dayBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={weekdayLong[id]}
                >
                  <Text style={[styles.dayBtnTxt, on && styles.dayBtnTxtOn, isRTL && styles.rtlText]} numberOfLines={1}>
                    {weekdayShort[id]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.sectionDivider} />

        <InlineTimePickerField label={timeLabel} value={time} onChange={setTime} labelTone="section" />
      </View>

      <View style={styles.preview}>
        <Text style={[styles.previewEyebrow, isRTL && styles.rtlText]}>{previewEyebrow}</Text>
        <Text style={[styles.previewValue, isRTL && styles.rtlText]} numberOfLines={2}>
          {previewDay} · {time}
        </Text>
        <Text style={[styles.previewMeta, isRTL && styles.rtlText]}>{previewMeta}</Text>
      </View>

      <View style={styles.saveWrap}>
        <PrimaryButton
          label={loading ? t("common.loading") : t("common.save")}
          onPress={save}
          loading={saving}
          loadingLabel={t("common.loading")}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl + theme.spacing.md },
  title: {
    fontSize: 22,
    fontWeight: "900",
    color: theme.colors.text,
    letterSpacing: -0.3,
    lineHeight: 28,
  },
  hint: {
    marginTop: 8,
    color: theme.colors.textMuted,
    lineHeight: 21,
    fontSize: 14,
    fontWeight: "500",
  },
  rtlText: { textAlign: "right" },
  card: {
    marginTop: theme.spacing.lg,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: theme.spacing.md,
  },
  section: { gap: 8 },
  sectionEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  dayTrack: {
    flexDirection: "row",
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: 3,
    gap: 3,
  },
  dayTrackRtl: { flexDirection: "row-reverse" },
  dayBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: theme.radius.sm,
    minHeight: 44,
  },
  dayBtnOn: { backgroundColor: theme.colors.cta },
  dayBtnPressed: { opacity: 0.88 },
  dayBtnTxt: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  dayBtnTxtOn: { color: theme.colors.ctaText },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
  },
  preview: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 4,
  },
  previewEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },
  previewValue: {
    fontSize: 17,
    fontWeight: "900",
    color: theme.colors.text,
    letterSpacing: -0.2,
    lineHeight: 24,
  },
  previewMeta: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  saveWrap: { marginTop: theme.spacing.lg },
});
