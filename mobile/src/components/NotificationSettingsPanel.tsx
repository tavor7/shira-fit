import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform, ActivityIndicator } from "react-native";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { useI18n } from "../context/I18nContext";
import { loadNotificationPrefs, saveNotificationPrefs, type NotificationPrefs } from "../lib/notificationPrefs";
import { syncExpoPushTokenIfNeeded } from "../lib/pushTokenSync";
import * as Notifications from "expo-notifications";

type Props = {
  /** Standalone screen shows main title; embedded in Profile uses tab label only. */
  variant?: "screen" | "embedded";
};

export function NotificationSettingsPanel({ variant = "screen" }: Props) {
  const { language, isRTL } = useI18n();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  const load = useCallback(async () => {
    setPrefs(await loadNotificationPrefs());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(key: keyof NotificationPrefs) {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await saveNotificationPrefs(next);
    if (key === "sessionReminders" || key === "waitlistAlerts") {
      if (!next.sessionReminders && !next.waitlistAlerts) {
        await Notifications.cancelAllScheduledNotificationsAsync();
      }
    }
    void syncExpoPushTokenIfNeeded();
  }

  if (!prefs) {
    return (
      <View style={[styles.loaderWrap, variant === "embedded" && styles.loaderWrapEmbedded]}>
        <ActivityIndicator color={theme.colors.cta} />
        <Text style={styles.muted}>…</Text>
      </View>
    );
  }

  const row = (label: string, value: boolean, k: keyof NotificationPrefs) => (
    <Pressable
      style={({ pressed }) => [styles.row, surface.card, pressed && styles.rowPressed]}
      onPress={() => void toggle(k)}
    >
      <Text style={[styles.rowLabel, isRTL && styles.rtl]}>{label}</Text>
      <View style={[styles.pill, value ? styles.pillOn : styles.pillOff]}>
        <Text style={[styles.pillTxt, value ? styles.pillTxtOn : styles.pillTxtOff]}>
          {value ? (language === "he" ? "פעיל" : "On") : language === "he" ? "כבוי" : "Off"}
        </Text>
      </View>
    </Pressable>
  );

  const embedded = variant === "embedded";

  return (
    <View style={[styles.block, embedded && styles.blockEmbedded]}>
      {!embedded ? (
        <Text style={[styles.h, isRTL && styles.rtl]}>{language === "he" ? "התראות" : "Notifications"}</Text>
      ) : (
        <Text style={[styles.sub, isRTL && styles.rtl]}>
          {language === "he" ? "בחרו אילו התראות לקבל במכשיר זה." : "Choose which alerts to receive on this device."}
        </Text>
      )}
      {Platform.OS === "web" ? (
        <Text style={[styles.note, isRTL && styles.rtl]}>
          {language === "he" ? "התראות מקומיות זמינות בעיקר בנייד." : "Local alerts work best on iOS/Android."}
        </Text>
      ) : null}
      {row(
        language === "he" ? "תזכורות לאימון (12–24 שעות לפני)" : "Workout reminders (12–24h before)",
        prefs.sessionReminders,
        "sessionReminders"
      )}
      {row(
        language === "he" ? "התראה כשיתפנה מקום (רשימת המתנה)" : "Alert when a waitlisted spot may open",
        prefs.waitlistAlerts,
        "waitlistAlerts"
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  blockEmbedded: { paddingTop: 4 },
  loaderWrap: { paddingVertical: 32, alignItems: "center", gap: 8 },
  loaderWrapEmbedded: { paddingVertical: 24 },
  h: { fontSize: 20, fontWeight: "900", color: theme.colors.text, marginBottom: 4 },
  sub: { fontSize: 14, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 20, marginBottom: 4 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  muted: { color: theme.colors.textMuted },
  note: { fontSize: 13, color: theme.colors.textSoft, marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: theme.radius.lg,
  },
  rowPressed: { opacity: 0.92 },
  rowLabel: { flex: 1, color: theme.colors.text, fontWeight: "700", fontSize: 15, paddingEnd: 14 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.full,
    minWidth: 52,
    alignItems: "center",
  },
  pillOn: { backgroundColor: "rgba(244,244,245,0.18)" },
  pillOff: { backgroundColor: theme.colors.accent },
  pillTxt: { fontWeight: "800", fontSize: 12 },
  pillTxtOn: { color: theme.colors.cta },
  pillTxtOff: { color: theme.colors.textSoft },
});
