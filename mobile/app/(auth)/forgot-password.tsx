import { useState } from "react";
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  ScrollView,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { buildAuthRedirectUrl } from "../../src/lib/authRedirect";

const MAX_EMAIL_LEN = 254;

export default function ForgotPasswordScreen() {
  const { t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function sendReset() {
    setErrorMessage("");
    if (!email.trim()) {
      setErrorMessage(t("auth.loginErrorEmailRequired"));
      return;
    }
    setBusy(true);
    try {
      const redirectTo = buildAuthRedirectUrl("/(auth)/reset-password");
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo,
      });
      if (error) {
        setErrorMessage(error.message);
        return;
      }
      router.replace({
        pathname: "/(auth)/forgot-sent",
        params: { email: email.trim() },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={styles.scrollRoot}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <LanguageToggleChip />
        <FadeSlideIn>
        <View style={styles.logoWrap}>
          <Image
            source={require("../../assets/logo.png")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel={t("a11y.appLogo")}
            accessibilityRole="image"
          />
        </View>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("auth.forgotPassword")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.hint}>
          {t("auth.forgotPasswordHint")}
        </AppText>
        {errorMessage ? (
          <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <AppText variant="caption" isRTL={isRTL} style={styles.errorText}>
              {errorMessage}
            </AppText>
          </View>
        ) : null}
        <AppTextField
          variant="dark"
          isRTL={isRTL}
          placeholder={t("auth.email")}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          value={email}
          maxLength={MAX_EMAIL_LEN}
          onChangeText={(v) => {
            setEmail(v);
            setErrorMessage("");
          }}
          accessibilityLabel={t("auth.email")}
          containerStyle={styles.field}
        />
        <PrimaryButton
          label={t("auth.sendResetLink")}
          loadingLabel={t("common.loading")}
          loading={busy}
          onPress={sendReset}
        />
        <ActionButton label={t("auth.backToSignIn")} onPress={() => router.push("/(auth)/login")} style={styles.navBtn} />
        </FadeSlideIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
    backgroundColor: theme.colors.backgroundAlt,
  },
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "flex-start",
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xl + theme.spacing.md,
    backgroundColor: theme.colors.backgroundAlt,
  },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl },
  logo: { width: 200, height: 41 },
  title: { marginBottom: theme.spacing.sm },
  hint: { marginBottom: theme.spacing.md },
  field: { marginBottom: theme.spacing.sm },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error },
});
