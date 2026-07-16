import { Redirect, useFocusEffect, Stack } from "expo-router";
import { useCallback, useState } from "react";
import { View, StyleSheet, Image, ScrollView, RefreshControl } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { isAthleteAccountDisabled } from "../../src/lib/profileAccount";
import { logRedirectToManagerSessions } from "../../src/lib/managerSessionsRedirectLog";
import { AppText } from "../../src/components/AppText";
import { ActionButton } from "../../src/components/ActionButton";
import { StudioContactFooter } from "../../src/components/StudioContactFooter";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";

export default function PendingScreen() {
  const { profile, refreshProfile, loading: authLoading, user } = useAuth();
  const { isRTL, t } = useI18n();
  const [checking, setChecking] = useState(false);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      await refreshProfile();
    } finally {
      setChecking(false);
    }
  }, [refreshProfile]);

  useFocusEffect(
    useCallback(() => {
      void checkNow();
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={checking} onRefresh={checkNow} tintColor={theme.colors.cta} />}
      >
        <FadeSlideIn>
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
          <ActionButton
            label={checking ? t("common.loading") : t("pending.checkAgain")}
            onPress={() => void checkNow()}
            disabled={checking}
            style={styles.checkBtn}
          />
        </View>
        </FadeSlideIn>
      </ScrollView>
      <StudioContactFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { flexGrow: 1, padding: theme.spacing.lg, paddingTop: theme.spacing.xl, justifyContent: "flex-start" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl + theme.spacing.md },
  logo: { width: 120, height: 24 },
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
  checkBtn: { marginTop: theme.spacing.md, alignSelf: "center" },
});
