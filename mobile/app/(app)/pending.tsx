import { Redirect, useFocusEffect, Stack } from "expo-router";
import { useCallback } from "react";
import { View, StyleSheet, Image } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { isAthleteAccountDisabled } from "../../src/lib/profileAccount";
import { logRedirectToManagerSessions } from "../../src/lib/managerSessionsRedirectLog";
import { AppText } from "../../src/components/AppText";
import { StudioContactFooter } from "../../src/components/StudioContactFooter";

export default function PendingScreen() {
  const { profile, refreshProfile, loading: authLoading, user } = useAuth();
  const { isRTL, t } = useI18n();

  useFocusEffect(
    useCallback(() => {
      refreshProfile().catch(() => undefined);
    }, [refreshProfile])
  );

  // If approval status changed, don't let the user get stuck here.
  if (profile?.role === "athlete" && isAthleteAccountDisabled(profile)) {
    return <Redirect href="/(app)/disabled" />;
  }
  if (profile?.role === "athlete" && profile.approval_status === "approved") {
    return <Redirect href="/(app)/athlete/sessions" />;
  }
  if (profile?.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  if (profile?.role === "manager") {
    logRedirectToManagerSessions("app/(app)/pending.tsx", "pending_screen_manager_role_exit", {
      authLoading,
      authUserId: user?.id ?? null,
      profileRole: profile?.role ?? null,
    });
    return <Redirect href="/(app)/manager/sessions" />;
  }

  const displayName = profile?.full_name || profile?.username || "";

  return (
    <View style={styles.box}>
      <Stack.Screen options={{ title: t("screen.pending") }} />
      <View style={styles.content}>
        <View style={styles.logoWrap}>
          <Image
            source={require("../../assets/logo.png")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel={t("a11y.appLogo")}
          />
        </View>
        <View style={styles.card}>
          <AppText variant="display" isRTL={isRTL} style={styles.title}>
            {t("pending.title")}
          </AppText>
          <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
            {t("pending.body").replace("{name}", displayName)}
          </AppText>
          <AppText variant="caption" soft isRTL={isRTL} style={styles.hint}>
            {t("pending.hint")}
          </AppText>
        </View>
      </View>
      <StudioContactFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { flex: 1, padding: theme.spacing.lg, justifyContent: "center" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.lg },
  logo: { width: 120, height: 120 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: theme.spacing.sm,
  },
  title: { letterSpacing: 0.2 },
  body: { lineHeight: 24 },
  hint: { marginTop: theme.spacing.xs, lineHeight: 20 },
});
