import { View, StyleSheet, Image } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { AppText } from "../../src/components/AppText";
import { PrimaryButton } from "../../src/components/PrimaryButton";

export default function ForgotSentScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { t, isRTL } = useI18n();
  const emailSuffix = email ? t("auth.forgotSentEmailSuffix").replace("{email}", String(email)) : "";

  return (
    <View style={styles.container}>
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
      </View>
      <AppText variant="display" isRTL={isRTL} style={styles.title}>
        {t("auth.checkEmail")}
      </AppText>
      <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
        {t("auth.forgotSentBody").replace("{emailSuffix}", emailSuffix)}
      </AppText>
      <PrimaryButton label={t("auth.backToSignIn")} onPress={() => router.replace("/(auth)/login")} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: { textAlign: "center", marginBottom: theme.spacing.md },
  body: { textAlign: "center", marginBottom: theme.spacing.lg },
});
