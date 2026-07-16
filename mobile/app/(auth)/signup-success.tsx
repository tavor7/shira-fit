import { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView, Image } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { AppText } from "../../src/components/AppText";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { surface } from "../../src/theme/surfaces";

export default function SignupSuccessScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { t, isRTL } = useI18n();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void logUserActivity("signup_completed");
  }, []);

  async function goLogin() {
    if (busy) return;
    setBusy(true);
    try {
      await supabase.auth.signOut();
      router.replace("/(auth)/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.scrollRoot} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <FadeSlideIn>
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
      </View>
      <View style={styles.card}>
        <View style={styles.badge}>
          <AppText variant="display" style={styles.badgeText}>
            ✓
          </AppText>
        </View>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("auth.signupSuccessTitle")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.lead}>
          {t("auth.signupSuccessLead")}
        </AppText>
        {email ? (
          <View style={styles.box}>
            <AppText variant="label" soft isRTL={isRTL} style={styles.boxLabel}>
              {t("auth.signupSuccessRegisteredEmail")}
            </AppText>
            <AppText variant="title">{email}</AppText>
          </View>
        ) : null}
        <AppText variant="caption" soft isRTL={isRTL} style={styles.note}>
          {t("auth.signupSuccessEmailNote")}
        </AppText>
        <PrimaryButton
          label={t("auth.backToSignIn")}
          loadingLabel={t("common.loading")}
          loading={busy}
          onPress={goLogin}
          style={styles.btn}
        />
      </View>
      <LanguageToggleChip />
      </FadeSlideIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: {
    flexGrow: 1,
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    justifyContent: "flex-start",
    backgroundColor: theme.colors.backgroundAlt,
  },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl + theme.spacing.md },
  logo: { width: 200, height: 41 },
  card: {
    ...surface.hero,
    maxWidth: 480,
    alignSelf: "center",
    width: "100%",
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.successBg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: theme.spacing.lg,
  },
  badgeText: { color: theme.colors.success },
  title: { textAlign: "center", marginBottom: theme.spacing.sm },
  lead: { textAlign: "center", marginBottom: theme.spacing.lg },
  box: {
    ...surface.cardCompact,
    marginBottom: theme.spacing.md,
  },
  boxLabel: { marginBottom: 4, textTransform: "uppercase" },
  note: { textAlign: "center", marginBottom: theme.spacing.lg },
  btn: { marginTop: 0 },
});
