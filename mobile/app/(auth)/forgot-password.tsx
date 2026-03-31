import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, KeyboardAvoidingView, Platform, Image } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { theme } from "../../src/theme";

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendReset() {
    if (!email.trim()) {
      Alert.alert("Email required");
      return;
    }
    setBusy(true);
    const redirectTo = Linking.createURL("/(auth)/reset-password");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });
    if (error) {
      setBusy(false);
      Alert.alert("Error", error.message);
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
      <View style={styles.logoWrap}>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={styles.title}>Forgot password</Text>
      <Text style={styles.hint}>Enter your account email. We’ll send a reset link.</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={theme.colors.textSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <PrimaryButton
        label="Send reset link"
        loadingLabel="Sending…"
        loading={busy}
        onPress={sendReset}
      />
      <ActionButton label="Back to sign in" onPress={() => router.push("/(auth)/login")} style={styles.navBtn} />
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
