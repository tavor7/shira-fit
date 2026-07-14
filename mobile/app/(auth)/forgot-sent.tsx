import { View, StyleSheet, Image, ScrollView, Pressable } from "react-native";
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
    <ScrollView style={styles.scrollRoot} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
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
      <Pressable
        onPress={() => router.replace("/(auth)/forgot-password")}
        style={({ pressed }) => [styles.wrongEmailLink, pressed && { opacity: 0.7 }]}
      >
        <AppText variant="caption" isRTL={isRTL} style={styles.wrongEmailTxt}>
          {t("auth.wrongEmail")}
        </AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { flexGrow: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: { textAlign: "center", marginBottom: theme.spacing.md },
  body: { textAlign: "center", marginBottom: theme.spacing.lg },
  wrongEmailLink: { marginTop: theme.spacing.lg, alignSelf: "center", padding: theme.spacing.sm },
  wrongEmailTxt: { color: theme.colors.cta, fontWeight: "700" },
});
