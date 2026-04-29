import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { logUserActivity } from "../../src/lib/logUserActivity";

export const options = { headerShown: false };

function getLoginErrorMessage(error: { message: string }): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("invalid login credentials") || msg.includes("invalid_credentials")) {
    return "Wrong email or password. If you don't have an account, sign up first. Otherwise check your password or use Forgot password.";
  }
  if (msg.includes("email not confirmed")) {
    return "Please confirm your email using the link we sent you, then try again.";
  }
  return error.message || "Login failed. Please try again.";
}

export default function LoginScreen() {
  const { language, t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  function tr(msgEn: string, msgHe: string) {
    return language === "he" ? msgHe : msgEn;
  }

  async function onLogin() {
    setErrorMessage("");
    if (!email.trim()) {
      setErrorMessage(tr("Please enter your email.", "אנא הזינו אימייל."));
      return;
    }
    if (!password) {
      setErrorMessage(tr("Please enter your password.", "אנא הזינו סיסמה."));
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) {
      const msg = getLoginErrorMessage(error);
      // Keep original error mapping but translate the common cases we generate in getLoginErrorMessage().
      if (msg.startsWith("Wrong email or password")) {
        setErrorMessage(
          tr(
            msg,
            "אימייל או סיסמה שגויים. אם אין לך חשבון, בצעו הרשמה. אחרת בדקו את הסיסמה או השתמשו ב״שכחתי סיסמה״."
          )
        );
      } else if (msg.startsWith("Please confirm your email")) {
        setErrorMessage(tr(msg, "אנא אשרו את האימייל דרך הקישור ששלחנו, ואז נסו שוב."));
      } else if (msg.startsWith("Login failed")) {
        setErrorMessage(tr(msg, "ההתחברות נכשלה. נסו שוב."));
      } else {
        setErrorMessage(msg);
      }
      return;
    }
    if (data.session) {
      void logUserActivity("auth_login");
      router.replace("/");
    } else {
      setErrorMessage(tr("Sign-in didn't complete. Please try again.", "ההתחברות לא הושלמה. נסו שוב."));
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.outer}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <LanguageToggleChip />
        <View style={styles.logoWrap}>
          <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
        </View>
        <Text style={[styles.sub, isRTL && styles.subRtl]}>{tr("Sign in to your account", "התחברות לחשבון")}</Text>
        {errorMessage ? (
          <View style={styles.errorBox}>
            <Text style={[styles.errorText, isRTL && { textAlign: "right" }]}>{errorMessage}</Text>
          </View>
        ) : null}
        <TextInput
          style={[styles.input, isRTL && styles.inputRtl, errorMessage ? styles.inputError : null]}
          placeholder={t("auth.email")}
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={(t) => { setEmail(t); setErrorMessage(""); }}
        />
        <TextInput
          style={[styles.input, isRTL && styles.inputRtl, errorMessage ? styles.inputError : null]}
          placeholder={t("auth.password")}
          placeholderTextColor={theme.colors.textSoft}
          secureTextEntry
          value={password}
          onChangeText={(t) => { setPassword(t); setErrorMessage(""); }}
        />
        <PrimaryButton
          label={t("auth.signIn")}
          loadingLabel={t("common.loading")}
          loading={busy}
          onPress={onLogin}
        />
        <ActionButton label={t("auth.forgotPassword") + "?"} onPress={() => router.push("/(auth)/forgot-password")} style={styles.navBtn} />
        <ActionButton label={t("auth.createAccount")} onPress={() => router.push("/(auth)/signup")} style={styles.navBtn} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
    paddingBottom: 48,
    backgroundColor: theme.colors.background,
  },
  logoWrap: {
    alignItems: "center",
    marginBottom: theme.spacing.lg,
  },
  logo: {
    width: 200,
    height: 200,
  },
  sub: {
    fontSize: 16,
    color: theme.colors.textMuted,
    textAlign: "center",
    marginBottom: theme.spacing.lg,
  },
  subRtl: { textAlign: "center" },
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error, fontSize: 14, lineHeight: 20 },
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
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  inputError: { borderColor: theme.colors.error },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
});
