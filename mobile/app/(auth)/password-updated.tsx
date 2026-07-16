import { useEffect } from "react";
import { View, StyleSheet, Image } from "react-native";
import { router } from "expo-router";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { AppText } from "../../src/components/AppText";
import { PrimaryButton } from "../../src/components/PrimaryButton";

export default function PasswordUpdatedScreen() {
  const { t, isRTL } = useI18n();

  useEffect(() => {
    void logUserActivity("password_reset_completed");
  }, []);

  return (
    <View style={styles.container}>
      <LanguageToggleChip />
      <FadeSlideIn>
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
      </View>
      <AppText variant="display" isRTL={isRTL} style={styles.title}>
        {t("auth.passwordUpdated")}
      </AppText>
      <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
        {t("auth.passwordUpdatedBody")}
      </AppText>
      <PrimaryButton label={t("auth.signIn")} onPress={() => router.replace("/(auth)/login")} />
      </FadeSlideIn>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    justifyContent: "flex-start",
    backgroundColor: theme.colors.backgroundAlt,
  },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl + theme.spacing.md },
  logo: { width: 200, height: 41 },
  title: { textAlign: "center", marginBottom: theme.spacing.sm },
  body: { textAlign: "center", marginBottom: theme.spacing.lg },
});
