import { useState } from "react";
import { View, StyleSheet, Image } from "react-native";
import { Stack, router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { useAuth } from "../../src/context/AuthContext";
import { saveNotificationPrefs } from "../../src/lib/notificationPrefs";
import { syncExpoPushTokenIfNeeded } from "../../src/lib/pushTokenSync";
import { syncWebPushSubscriptionIfNeeded } from "../../src/lib/webPushSync";
import { ensureNotificationPermission } from "../../src/lib/sessionReminders";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";

/**
 * One-time gate, shown once per account (profiles.notifications_onboarded_at) — applies
 * equally to brand-new signups and accounts that existed before this prompt was added.
 */
export default function NotificationsOnboardingScreen() {
  const { t, isRTL } = useI18n();
  const { refreshProfile } = useAuth();
  const [busy, setBusy] = useState<"enable" | "skip" | null>(null);

  async function finish(enable: boolean) {
    setBusy(enable ? "enable" : "skip");
    try {
      await saveNotificationPrefs({ sessionReminders: enable, waitlistAlerts: enable });

      if (enable) {
        try {
          await ensureNotificationPermission();
        } catch {
          /* native permission prompt unsupported/denied — continue anyway */
        }
        await Promise.all([syncExpoPushTokenIfNeeded(), syncWebPushSubscriptionIfNeeded()]);
      }

      await supabase.rpc("mark_notifications_onboarded");
      await refreshProfile();
      router.replace("/");
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t("screen.notificationsOnboarding") }} />
      <FadeSlideIn>
        <View style={styles.logoWrap}>
          <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
        </View>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("notificationsOnboarding.title")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
          {t("notificationsOnboarding.body")}
        </AppText>
        <PrimaryButton
          label={t("notificationsOnboarding.enable")}
          loadingLabel={t("common.loading")}
          loading={busy === "enable"}
          disabled={busy !== null}
          onPress={() => void finish(true)}
        />
        <ActionButton
          label={t("notificationsOnboarding.skip")}
          onPress={() => void finish(false)}
          disabled={busy !== null}
          style={styles.skipBtn}
        />
      </FadeSlideIn>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt, justifyContent: "center" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl },
  logo: { width: 200, height: 41 },
  title: { marginBottom: theme.spacing.sm, textAlign: "center" },
  body: { marginBottom: theme.spacing.lg, textAlign: "center", lineHeight: 22 },
  skipBtn: { marginTop: theme.spacing.md, alignSelf: "center" },
});
