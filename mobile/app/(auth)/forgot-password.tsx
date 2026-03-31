import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, KeyboardAvoidingView, Platform, Image } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

export default function ForgotPasswordScreen() {
  const { language, t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendReset() {
    if (!email.trim()) {
      Alert.alert(language === "he" ? "נדרש אימייל" : "Email required");
      return;
    }
    setBusy(true);
    const redirectTo = Linking.createURL("/(auth)/reset-password");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });
    if (error) {
      setBusy(false);
      Alert.alert(t("common.error"), error.message);
      return;
    }
    setBusy(false);
    router.replace({
      pathname: "/(auth)/forgot-sent",
      params: { email: email.trim() },
    });
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={[styles.title, isRTL && { textAlign: "right" }]}>{t("auth.forgotPassword")}</Text>
      <Text style={[styles.hint, isRTL && { textAlign: "right" }]}>
        {language === "he" ? "הזינו את אימייל החשבון. נשלח קישור לאיפוס סיסמה." : "Enter your account email. We’ll send a reset link."}
      </Text>
      <TextInput
        style={styles.input}
        placeholder={t("auth.email")}
        placeholderTextColor={theme.colors.textSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <PrimaryButton
        label={language === "he" ? "שליחת קישור איפוס" : "Send reset link"}
        loadingLabel={t("common.loading")}
        loading={busy}
        onPress={sendReset}
      />
      <ActionButton label={language === "he" ? "חזרה להתחברות" : "Back to sign in"} onPress={() => router.push("/(auth)/login")} style={styles.navBtn} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.background },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 8, color: theme.colors.text },
  hint: { color: theme.colors.textMuted, marginBottom: 20, lineHeight: 22 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 14,
    marginBottom: theme.spacing.md,
    fontSize: 16,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  navBtn: { marginTop: theme.spacing.lg, alignSelf: "center", width: "100%" },
});
