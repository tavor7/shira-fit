import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

/**
 * User lands here after clicking the email link (tokens in URL hash on web).
 * Supabase must have this redirect URL allowlisted.
 */
export default function ResetPasswordScreen() {
  const { language, t, isRTL } = useI18n();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        // Supabase recovery links can be either:
        // - legacy implicit: tokens in hash (#access_token=...&refresh_token=...)
        // - PKCE: code in query (?code=...)
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
        Alert.alert(
          language === "he" ? "קישור לא תקין או שפג תוקפו" : "Invalid or expired link",
          language === "he" ? "בקשו אימייל איפוס חדש מ״שכחתי סיסמה״." : "Request a new reset email from Forgot password."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (password.length < 6) {
      Alert.alert(
        language === "he" ? "סיסמה קצרה מדי" : "Password too short",
        language === "he" ? "השתמשו בלפחות 6 תווים." : "Use at least 6 characters."
      );
      return;
    }
    if (password !== password2) {
      Alert.alert(
        language === "he" ? "אי התאמה" : "Mismatch",
        language === "he" ? "הסיסמאות אינן תואמות." : "Passwords do not match."
      );
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
      <View style={[styles.container, { justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.loadingText, isRTL && { textAlign: "right" }]}>{t("common.loading")}</Text>
      </View>
    );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <LanguageToggleChip />
      <Text style={[styles.title, isRTL && { textAlign: "right" }]}>{language === "he" ? "סיסמה חדשה" : "New password"}</Text>
      <Text style={[styles.hint, isRTL && { textAlign: "right" }]}>
        {language === "he" ? "בחרו סיסמה חדשה לחשבון שלכם." : "Choose a new password for your account."}
      </Text>
      <TextInput
        style={styles.input}
        placeholder={language === "he" ? "סיסמה חדשה (מינימום 6)" : "New password (min 6)"}
        placeholderTextColor={theme.colors.textSoft}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <TextInput
        style={styles.input}
        placeholder={language === "he" ? "אישור סיסמה" : "Confirm password"}
        placeholderTextColor={theme.colors.textSoft}
        secureTextEntry
        value={password2}
        onChangeText={setPassword2}
      />
      <PrimaryButton
        label={language === "he" ? "עדכון סיסמה" : "Update password"}
        loadingLabel={t("common.loading")}
        loading={busy}
        onPress={save}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.background },
  loadingText: { textAlign: "center", marginTop: 12, color: theme.colors.textMuted },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 8, color: theme.colors.text },
  hint: { color: theme.colors.textMuted, marginBottom: 20 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 14,
    marginBottom: theme.spacing.sm,
    fontSize: 16,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
});
