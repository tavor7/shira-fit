import { useState, useEffect } from "react";
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { LoadingState } from "../../src/components/LoadingState";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { useAppAlert } from "../../src/context/AppAlertContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

/**
 * User lands here after clicking the email link (tokens in URL hash on web).
 * Supabase must have this redirect URL allowlisted.
 */
export default function ResetPasswordScreen() {
  const { t, isRTL } = useI18n();
  const { showOk } = useAppAlert();
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(true);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        if (code) {
          try {
            await supabase.auth.exchangeCodeForSession(code);
          } catch {
            // ignore; we'll validate via getSession below
          }
          url.searchParams.delete("code");
          window.history.replaceState(null, "", url.pathname + (url.search ? `?${url.searchParams.toString()}` : ""));
        } else {
          const hash = window.location.hash;
          if (hash && hash.includes("access_token")) {
            const params = new URLSearchParams(hash.replace(/^#/, ""));
            const access_token = params.get("access_token");
            const refresh_token = params.get("refresh_token");
            if (access_token && refresh_token) {
              await supabase.auth.setSession({ access_token, refresh_token });
              window.history.replaceState(null, "", window.location.pathname + window.location.search);
            }
          }
        }
      }
      const { data } = await supabase.auth.getSession();
      if (!cancelled) setReady(true);
      if (!data.session) {
        if (!cancelled) setHasSession(false);
        showOk(t("auth.resetLinkInvalidTitle"), t("auth.resetLinkInvalidBody"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, showOk]);

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
    setBusy(false);
    if (error) setErrorMessage(error.message);
    else router.replace("/(auth)/password-updated");
  }

  if (!ready) return <LoadingState label={t("common.loading")} isRTL={isRTL} style={[styles.container, styles.centered]} />;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
      </View>
      <AppText variant="display" isRTL={isRTL} style={styles.title}>
        {t("auth.resetPasswordNewTitle")}
      </AppText>
      <AppText variant="body" muted isRTL={isRTL} style={styles.hint}>
        {t("auth.resetPasswordHint")}
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
        editable={hasSession}
        containerStyle={styles.field}
      />
      <AppTextField
        variant="dark"
        isRTL={isRTL}
        placeholder={t("auth.resetPasswordConfirmPlaceholder")}
        secureTextEntry
        value={password2}
        onChangeText={setPassword2}
        editable={hasSession}
        containerStyle={styles.field}
      />
      <PrimaryButton
        label={t("auth.resetPasswordUpdate")}
        loadingLabel={t("common.loading")}
        loading={busy}
        disabled={!hasSession}
        onPress={save}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  centered: { justifyContent: "center" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
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
