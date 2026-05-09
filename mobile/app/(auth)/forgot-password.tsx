import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
  ScrollView,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { buildAuthRedirectUrl } from "../../src/lib/authRedirect";

const MAX_EMAIL_LEN = 254;

export default function ForgotPasswordScreen() {
  const { t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendReset() {
    if (!email.trim()) {
      Alert.alert(t("common.error"), t("auth.loginErrorEmailRequired"));
      return;
    }
    setBusy(true);
    try {
      const redirectTo = buildAuthRedirectUrl("/(auth)/reset-password");
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo,
      });
      if (error) {
        Alert.alert(t("common.error"), error.message);
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
        <View style={styles.logoWrap}>
          <Image
            source={require("../../assets/logo.png")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel={t("a11y.appLogo")}
            accessibilityRole="image"
          />
        </View>
        <Text style={[styles.title, isRTL && styles.rtlText]}>{t("auth.forgotPassword")}</Text>
        <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("auth.forgotPasswordHint")}</Text>
        <TextInput
          style={[styles.input, isRTL && styles.inputRtl]}
          placeholder={t("auth.email")}
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          value={email}
          maxLength={MAX_EMAIL_LEN}
          onChangeText={setEmail}
          accessibilityLabel={t("auth.email")}
        />
        <PrimaryButton
          label={t("auth.sendResetLink")}
          loadingLabel={t("common.loading")}
          loading={busy}
          onPress={sendReset}
        />
        <ActionButton label={t("auth.backToSignIn")} onPress={() => router.push("/(auth)/login")} style={styles.navBtn} />
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
  rtlText: { textAlign: "right" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: {
    fontSize: 22,
    fontWeight: "800",
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
    letterSpacing: 0.2,
    lineHeight: 26,
  },
  hint: {
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
    lineHeight: 22,
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 0.15,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    fontSize: 16,
    lineHeight: 22,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
});
