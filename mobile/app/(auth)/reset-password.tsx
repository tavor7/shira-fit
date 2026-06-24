import { useState, useEffect } from "react";
import {
  View,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

/**
 * User lands here after clicking the email link (tokens in URL hash on web).
 * Supabase must have this redirect URL allowlisted.
 */
export default function ResetPasswordScreen() {
  const { t, isRTL } = useI18n();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

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
        Alert.alert(t("auth.resetLinkInvalidTitle"), t("auth.resetLinkInvalidBody"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function save() {
    if (password.length < 6) {
      Alert.alert(t("auth.passwordTooShortTitle"), t("auth.passwordTooShortBody"));
      return;
    }
    if (password !== password2) {
      Alert.alert(t("auth.passwordMismatchTitle"), t("auth.passwordMismatchBody"));
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) Alert.alert(t("common.error"), error.message);
    else router.replace("/(auth)/password-updated");
  }

  if (!ready)
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <AppText variant="body" muted isRTL={isRTL} style={styles.loadingText}>
          {t("common.loading")}
        </AppText>
      </View>
    );

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
        onPress={save}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  centered: { justifyContent: "center" },
  loadingText: { textAlign: "center", marginTop: theme.spacing.sm },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: { marginBottom: theme.spacing.sm },
  hint: { marginBottom: theme.spacing.lg },
  field: { marginBottom: theme.spacing.sm },
});
