import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform, ActivityIndicator } from "react-native";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { loadNotificationPrefs, saveNotificationPrefs, type NotificationPrefs } from "../lib/notificationPrefs";
import { syncExpoPushTokenIfNeeded } from "../lib/pushTokenSync";
import { syncWebPushSubscriptionIfNeeded } from "../lib/webPushSync";
import * as Notifications from "expo-notifications";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { AppTextField } from "./AppTextField";
import { PrimaryButton } from "./PrimaryButton";
import {
  fetchWhatsAppFeatureState,
  setWhatsAppNotificationsEnabled,
  type WhatsAppFeatureState,
} from "../lib/whatsappFeature";

type Props = {
  /** Standalone screen shows main title; embedded in Profile uses tab label only. */
  variant?: "screen" | "embedded";
};

const TEST_NOTIFICATION_TYPES = [
  "weekly_open",
  "day_before",
  "hour_before",
  "waitlist_spot",
  "session_updated",
] as const;
type TestNotificationType = (typeof TEST_NOTIFICATION_TYPES)[number];

export function NotificationSettingsPanel({ variant = "screen" }: Props) {
  const { isRTL, t } = useI18n();
  const { profile } = useAuth();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [waState, setWaState] = useState<WhatsAppFeatureState | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [killSwitchOn, setKillSwitchOn] = useState<boolean | null>(null);
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [testBusyType, setTestBusyType] = useState<TestNotificationType | null>(null);
  const [customBody, setCustomBody] = useState("");
  const [customBusy, setCustomBusy] = useState(false);

  const isManager = profile?.role === "manager";

  const load = useCallback(async () => {
    setPrefs(await loadNotificationPrefs());
    const state = await fetchWhatsAppFeatureState();
    setWaState(state);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isManager) return;
    void (async () => {
      const { data } = await supabase.rpc("get_push_kill_switch");
      const res = data as { ok?: boolean; enabled?: boolean } | null;
      if (res?.ok) setKillSwitchOn(res.enabled !== false);
    })();
  }, [isManager]);

  /** Single on/off — both underlying prefs always move together. */
  async function toggleAll() {
    if (!prefs) return;
    const next = !(prefs.sessionReminders && prefs.waitlistAlerts);
    const nextPrefs: NotificationPrefs = { sessionReminders: next, waitlistAlerts: next };
    setPrefs(nextPrefs);
    await saveNotificationPrefs(nextPrefs);
    if (!next && Platform.OS !== "web") {
      try {
        await Notifications.cancelAllScheduledNotificationsAsync();
      } catch {
        // ignore (permissions missing, not supported, etc.)
      }
    }
    void syncExpoPushTokenIfNeeded();
    void syncWebPushSubscriptionIfNeeded();
  }

  async function toggleWhatsApp() {
    if (!waState?.can_see_settings) return;
    const next = !waState.whatsapp_enabled;
    setWaLoading(true);
    const res = await setWhatsAppNotificationsEnabled(next);
    setWaLoading(false);
    if (!res.ok) {
      const msg = res.error === "invalid_phone" ? t("whatsapp.invalidPhone") : res.error ?? t("common.failed");
      showToast({ message: msg, variant: "error" });
      return;
    }
    const refreshed = await fetchWhatsAppFeatureState();
    setWaState(refreshed);
  }

  async function toggleKillSwitch() {
    if (killSwitchOn === null || killSwitchBusy) return;
    const next = !killSwitchOn;
    setKillSwitchBusy(true);
    try {
      const { data, error } = await supabase.rpc("set_push_kill_switch", { p_enabled: next });
      const res = data as { ok?: boolean; enabled?: boolean; error?: string } | null;
      if (error || !res?.ok) {
        showToast({ message: t("common.error"), detail: error?.message ?? res?.error, variant: "error" });
        return;
      }
      setKillSwitchOn(res.enabled !== false);
      showToast({
        message: next ? t("notifications.killSwitchOnToast") : t("notifications.killSwitchOffToast"),
        variant: next ? "success" : "info",
      });
    } finally {
      setKillSwitchBusy(false);
    }
  }

  async function sendTest(type: TestNotificationType) {
    if (testBusyType) return;
    setTestBusyType(type);
    try {
      const { data, error } = await supabase.rpc("send_test_push_notification", { p_type: type });
      const res = data as { ok?: boolean; error?: string } | null;
      if (error || !res?.ok) {
        showToast({ message: t("common.error"), detail: error?.message ?? res?.error, variant: "error" });
        return;
      }
      showToast({ message: t("notifications.testSentToast"), variant: "success" });
    } finally {
      setTestBusyType(null);
    }
  }

  function sendCustomBroadcast() {
    const body = customBody.trim();
    if (!body || customBusy) return;

    showConfirm({
      title: t("notifications.customConfirmTitle"),
      message: t("notifications.customConfirmMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("notifications.customSend"),
      confirmVariant: "primary",
      onConfirm: () => {
        void (async () => {
          setCustomBusy(true);
          try {
            const { data, error } = await supabase.rpc("send_custom_push_notification", {
              p_body: body,
            });
            const res = data as { ok?: boolean; notified?: number; error?: string } | null;
            if (error || !res?.ok) {
              const msg =
                res?.error === "push_disabled"
                  ? t("notifications.customErrorPushDisabled")
                  : res?.error ?? error?.message;
              showToast({ message: t("common.error"), detail: msg, variant: "error" });
              return;
            }
            showToast({
              message: t("notifications.customSentToast").replace("{count}", String(res.notified ?? 0)),
              variant: "success",
            });
            setCustomBody("");
          } finally {
            setCustomBusy(false);
          }
        })();
      },
    });
  }

  if (!prefs) {
    return (
      <View style={[styles.loaderWrap, variant === "embedded" && styles.loaderWrapEmbedded]}>
        <ActivityIndicator color={theme.colors.cta} />
        <Text style={styles.muted}>…</Text>
      </View>
    );
  }

  const allOn = prefs.sessionReminders && prefs.waitlistAlerts;
  const embedded = variant === "embedded";

  const pill = (on: boolean) => (
    <View style={[styles.pill, on ? styles.pillOn : styles.pillOff]}>
      <Text style={[styles.pillTxt, on ? styles.pillTxtOn : styles.pillTxtOff]}>
        {on ? t("notifications.on") : t("notifications.off")}
      </Text>
    </View>
  );

  return (
    <View style={[styles.block, embedded && styles.blockEmbedded]}>
      {!embedded ? (
        <Text style={[styles.h, isRTL && styles.rtl]}>{t("profile.tabNotifications")}</Text>
      ) : (
        <Text style={[styles.sub, isRTL && styles.rtl]}>{t("notifications.chooseHint")}</Text>
      )}
      {Platform.OS === "web" ? (
        <Text style={[styles.note, isRTL && styles.rtl]}>{t("notifications.webHint")}</Text>
      ) : null}

      <Pressable
        style={({ pressed }) => [styles.row, surface.card, pressed && styles.rowPressed]}
        onPress={() => void toggleAll()}
        accessibilityRole="switch"
        accessibilityState={{ checked: allOn }}
      >
        <Text style={[styles.rowLabel, isRTL && styles.rtl]}>{t("notifications.allLabel")}</Text>
        {pill(allOn)}
      </Pressable>

      {waState?.can_see_settings ? (
        <View style={styles.waBlock}>
          <Text style={[styles.waTitle, isRTL && styles.rtl]}>{t("whatsapp.settingsTitle")}</Text>
          <Text style={[styles.waSub, isRTL && styles.rtl]}>{t("whatsapp.settingsSubtitle")}</Text>
          {waState.whatsapp_phone_e164 ? (
            <Text style={[styles.waPhone, isRTL && styles.rtl]}>
              {t("whatsapp.settingsPhone").replace("{phone}", waState.whatsapp_phone_e164)}
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.row, surface.card, pressed && styles.rowPressed, waLoading && styles.rowDisabled]}
            onPress={() => void toggleWhatsApp()}
            disabled={waLoading}
          >
            <Text style={[styles.rowLabel, isRTL && styles.rtl]}>{t("whatsapp.settingsEnable")}</Text>
            {pill(waState.whatsapp_enabled === true)}
          </Pressable>
        </View>
      ) : null}

      {isManager ? (
        <View style={styles.managerBlock}>
          <Text style={[styles.managerTitle, isRTL && styles.rtl]}>{t("notifications.managerSectionTitle")}</Text>

          <Pressable
            style={({ pressed }) => [
              styles.row,
              surface.card,
              styles.killSwitchRow,
              pressed && styles.rowPressed,
              (killSwitchBusy || killSwitchOn === null) && styles.rowDisabled,
            ]}
            onPress={() => void toggleKillSwitch()}
            disabled={killSwitchBusy || killSwitchOn === null}
            accessibilityRole="switch"
            accessibilityState={{ checked: killSwitchOn === true }}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, isRTL && styles.rtl]}>{t("notifications.killSwitchLabel")}</Text>
              <Text style={[styles.killSwitchHint, isRTL && styles.rtl]}>{t("notifications.killSwitchHint")}</Text>
            </View>
            {killSwitchOn === null ? (
              <ActivityIndicator color={theme.colors.cta} />
            ) : (
              pill(killSwitchOn)
            )}
          </Pressable>

          <Text style={[styles.testSectionTitle, isRTL && styles.rtl]}>{t("notifications.testSectionTitle")}</Text>
          <Text style={[styles.testSectionHint, isRTL && styles.rtl]}>{t("notifications.testSectionHint")}</Text>
          <View style={styles.testGrid}>
            {TEST_NOTIFICATION_TYPES.map((type) => (
              <Pressable
                key={type}
                style={({ pressed }) => [
                  styles.testBtn,
                  pressed && !testBusyType && styles.rowPressed,
                  testBusyType && testBusyType !== type && styles.rowDisabled,
                ]}
                onPress={() => void sendTest(type)}
                disabled={testBusyType !== null}
              >
                <Text style={styles.testBtnTxt}>
                  {testBusyType === type ? t("common.loading") : t(`notifications.testType.${type}` as const)}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.testSectionTitle, isRTL && styles.rtl]}>{t("notifications.customSectionTitle")}</Text>
          <Text style={[styles.testSectionHint, isRTL && styles.rtl]}>{t("notifications.customSectionHint")}</Text>

          <AppTextField
            variant="dark"
            isRTL={isRTL}
            label={t("notifications.customBodyLabel")}
            placeholder={t("notifications.customBodyPlaceholder")}
            value={customBody}
            onChangeText={setCustomBody}
            multiline
            maxLength={500}
            containerStyle={styles.customField}
          />
          <PrimaryButton
            label={t("notifications.customSend")}
            loadingLabel={t("common.loading")}
            loading={customBusy}
            disabled={!customBody.trim()}
            onPress={sendCustomBroadcast}
            style={styles.customSendBtn}
          />
        </View>
      ) : null}
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
  rowDisabled: { opacity: 0.6 },
  waBlock: { marginTop: 8, gap: 8 },
  waTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  waSub: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  waPhone: { fontSize: 12, color: theme.colors.textSoft, fontWeight: "600" },
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
  managerBlock: { marginTop: 16, gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderMuted, paddingTop: 16 },
  managerTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  killSwitchRow: { alignItems: "flex-start" },
  killSwitchHint: { fontSize: 12, color: theme.colors.textSoft, marginTop: 3, lineHeight: 16 },
  testSectionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text, marginTop: 8 },
  testSectionHint: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 16 },
  testGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  testBtn: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  testBtnTxt: { color: theme.colors.text, fontWeight: "700", fontSize: 13 },
  customField: { marginTop: 8 },
  customSendBtn: { marginTop: 8 },
});
