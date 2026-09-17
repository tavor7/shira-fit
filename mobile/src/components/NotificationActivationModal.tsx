import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { AnimatedCheckMark } from "./AnimatedCheckMark";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import {
  activateAllNotifications,
  clearPendingNotificationPrompt,
  fetchPendingNotificationPrompt,
} from "../lib/notificationActivation";
import { fetchMarketingConsentStatus, recordUserConsent, type MarketingConsentStatus } from "../lib/consent";

/**
 * Manager-queued, one-time re-prompt for users currently notifications-off. Distinct from
 * the once-ever NotificationsOnboardingScreen: this is dismissible via X (with a confirm
 * step, not a hard block) and re-triggerable per manager batch via
 * notification_prompt_queued_at. Rendered as an overlay inside (app)/_layout.tsx.
 */
export function NotificationActivationModal() {
  const { session } = useAuth();
  const { t, isRTL } = useI18n();
  const userId = session?.user?.id ?? null;

  const [visible, setVisible] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [marketing, setMarketing] = useState<MarketingConsentStatus | null>(null);
  const [marketingChecked, setMarketingChecked] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const pending = await fetchPendingNotificationPrompt(userId);
      if (cancelled || !pending) return;
      setMarketing(await fetchMarketingConsentStatus());
      setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId || !visible) return null;

  async function finish() {
    if (!userId) return;
    await clearPendingNotificationPrompt(userId);
    setVisible(false);
    setConfirmSkip(false);
  }

  async function activate() {
    if (busy) return;
    setBusy(true);
    try {
      // Same call the Alerts toggle makes — guarantees identical behavior.
      await activateAllNotifications();
      if (marketingChecked && marketing?.available && !marketing.accepted) {
        await recordUserConsent({
          consent_type: "marketing_communications",
          status: "accepted",
          consent_version: marketing.version,
        });
      }
      await finish();
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (busy) return;
    setConfirmSkip(true);
  }

  return (
    <AppModal
      visible={visible}
      onClose={requestClose}
      variant="sheet"
      backdropAccessibilityLabel={t("common.cancel")}
    >
      {confirmSkip ? (
        <View style={styles.card}>
          <View style={styles.warnIcon}>
            <Text style={styles.warnIconTxt}>!</Text>
          </View>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("notificationsPrompt.skipTitle")}</Text>
          <Text style={[styles.body, isRTL && styles.rtl]}>{t("notificationsPrompt.skipBody")}</Text>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.9 }]}
            onPress={() => setConfirmSkip(false)}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryBtnTxt}>{t("notificationsPrompt.goBack")}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.8 }]}
            onPress={() => void finish()}
            accessibilityRole="button"
          >
            <Text style={styles.skipBtnTxt}>{t("notificationsPrompt.skipAnyway")}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.topRow}>
            <View style={styles.bellBadge}>
              <Text style={styles.bellGlyph}>🔔</Text>
            </View>
            <Pressable
              onPress={requestClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
              style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.8 }]}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
          </View>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("notificationsPrompt.title")}</Text>
          <Text style={[styles.body, isRTL && styles.rtl]}>{t("notificationsPrompt.body")}</Text>

          {marketing?.available ? (
            <Pressable
              style={({ pressed }) => [styles.checkRow, pressed && { opacity: 0.9 }]}
              onPress={() => setMarketingChecked((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: marketingChecked }}
            >
              <View style={[styles.checkbox, marketingChecked && styles.checkboxOn]}>
                <AnimatedCheckMark visible={marketingChecked} style={styles.checkboxMark} />
              </View>
              <View style={styles.checkCopyWrap}>
                <Text style={[styles.checkTitle, isRTL && styles.rtl]}>{t("notificationsPrompt.marketingLabel")}</Text>
                <Text style={[styles.checkSub, isRTL && styles.rtl]}>{t("notificationsPrompt.marketingHint")}</Text>
              </View>
            </Pressable>
          ) : null}

          <PrimaryButton
            label={t("notificationsPrompt.activate")}
            loadingLabel={t("common.loading")}
            loading={busy}
            onPress={() => void activate()}
            style={styles.activateBtn}
          />
        </View>
      )}
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  topRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  bellBadge: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.infoBg,
    alignItems: "center",
    justifyContent: "center",
  },
  bellGlyph: { fontSize: 20 },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  closeGlyph: { fontSize: 16, color: theme.colors.textMuted, lineHeight: 18 },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginTop: 4 },
  body: { fontSize: 13.5, lineHeight: 20, color: theme.colors.textMuted },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginTop: 4,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 12 },
  checkCopyWrap: { flex: 1 },
  checkTitle: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  checkSub: { fontSize: 11.5, color: theme.colors.textSoft, marginTop: 2, lineHeight: 15 },
  activateBtn: { marginTop: 6 },
  warnIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.warningBg,
    alignItems: "center",
    justifyContent: "center",
  },
  warnIconTxt: { color: theme.colors.warning, fontWeight: "900", fontSize: 18 },
  secondaryBtn: {
    marginTop: 6,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  skipBtn: { paddingVertical: 10, alignItems: "center" },
  skipBtnTxt: { color: theme.colors.error, fontWeight: "700", fontSize: 13 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
