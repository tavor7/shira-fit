import { useState } from "react";
import { View, StyleSheet, KeyboardAvoidingView, Platform, Image } from "react-native";
import { Stack, router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { useAuth } from "../../src/context/AuthContext";
import { useToast } from "../../src/context/ToastContext";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";

/** How long the success checkmark holds before leaving to the app's home screen. */
const SUCCESS_HOLD_MS = 1200;

/** Forced gate: shown when staff issued a temporary password (profiles.must_change_password). */
export default function ChangePasswordRequiredScreen() {
  const { t, isRTL } = useI18n();
  const { refreshProfile } = useAuth();
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function save() {
    setErrorMessage("");
    if (password.length < 6) {
      setErrorMessage(t("auth.passwordTooShortBody"));
      return;
    }
    if (password !== password2) {
      setErrorMessage(t("auth.passwordMismatchBody"));
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      setErrorMessage(error.message);
      return;
    }
    const { error: clearError } = await supabase.rpc("clear_must_change_password");
    if (clearError) {
      setBusy(false);
      setErrorMessage(clearError.message);
      return;
    }
    await refreshProfile();
    setBusy(false);
    setSuccess(true);
    showToast({ message: t("auth.passwordUpdated"), variant: "success" });
    await new Promise((resolve) => setTimeout(resolve, SUCCESS_HOLD_MS));
    router.replace("/");
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <Stack.Screen options={{ title: t("screen.changePasswordRequired") }} />
      <FadeSlideIn>
        <View style={styles.logoWrap}>
          <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
        </View>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("auth.resetPasswordNewTitle")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.hint}>
          {t("changePasswordRequired.hint")}
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
          placeholder={t("auth.resetPasswordNewPlaceholder")}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          containerStyle={styles.field}
        />
        <AppTextField
          variant="dark"
          isRTL={isRTL}
          placeholder={t("auth.resetPasswordConfirmPlaceholder")}
          secureTextEntry
          value={password2}
          onChangeText={setPassword2}
          containerStyle={styles.field}
        />
        <PrimaryButton
          label={t("auth.resetPasswordUpdate")}
          loadingLabel={t("common.loading")}
          loading={busy}
          success={success}
          disabled={success}
          onPress={save}
        />
      </FadeSlideIn>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl },
  logo: { width: 200, height: 41 },
  title: { marginBottom: theme.spacing.sm },
  hint: { marginBottom: theme.spacing.lg },
  field: { marginBottom: theme.spacing.sm },
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
