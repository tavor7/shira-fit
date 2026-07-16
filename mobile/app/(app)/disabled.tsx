import { Redirect, useFocusEffect, Stack } from "expo-router";
import { useCallback, useState } from "react";
import { View, StyleSheet, Image, ScrollView, RefreshControl } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { isAthleteAccountDisabled } from "../../src/lib/profileAccount";
import { AppText } from "../../src/components/AppText";
import { ActionButton } from "../../src/components/ActionButton";
import { StudioContactFooter } from "../../src/components/StudioContactFooter";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";

export default function DisabledAccountScreen() {
  const { profile, refreshProfile } = useAuth();
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

  if (profile && !isAthleteAccountDisabled(profile)) {
    if (profile.role === "athlete" && profile.approval_status === "pending") {
      return <Redirect href="/(app)/pending" />;
    }
    if (profile.role === "athlete") return <Redirect href="/(app)/athlete/sessions" />;
    if (profile.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
    if (profile.role === "manager") return <Redirect href="/(app)/manager/sessions" />;
  }

  return (
    <View style={styles.box}>
      <Stack.Screen options={{ title: t("screen.accountDisabled") }} />
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
            {t("accountDisabled.title")}
          </AppText>
          <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
            {t("accountDisabled.message")}
          </AppText>
          <AppText variant="caption" isRTL={isRTL} style={styles.supportHint}>
            {t("accountDisabled.supportHint")}
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
  supportHint: { marginTop: theme.spacing.sm, lineHeight: 20, color: theme.colors.textSoft },
  checkBtn: { marginTop: theme.spacing.md, alignSelf: "center" },
});
