import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { theme } from "../../src/theme";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function onLogin() {
    setErrorMessage("");
    if (!email.trim()) {
      setErrorMessage("Please enter your email.");
      return;
    }
    if (!password) {
      setErrorMessage("Please enter your password.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) {
      setErrorMessage(getLoginErrorMessage(error));
      return;
    }
    if (data.session) {
      router.replace("/");
    } else {
      setErrorMessage("Sign-in didn't complete. Please try again.");
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={styles.sub}>Sign in to your account</Text>
      {errorMessage ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
      <TextInput
        style={[styles.input, errorMessage ? styles.inputError : null]}
        placeholder="Email"
        placeholderTextColor={theme.colors.textSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={(t) => { setEmail(t); setErrorMessage(""); }}
      />
      <TextInput
        style={[styles.input, errorMessage ? styles.inputError : null]}
        placeholder="Password"
        placeholderTextColor={theme.colors.textSoft}
        secureTextEntry
        value={password}
        onChangeText={(t) => { setPassword(t); setErrorMessage(""); }}
      />
      <PrimaryButton
        label="Log in"
        loadingLabel="Signing in…"
        loading={busy}
        onPress={onLogin}
      />
      <ActionButton label="Forgot password?" onPress={() => router.push("/(auth)/forgot-password")} style={styles.navBtn} />
      <ActionButton label="Create account" onPress={() => router.push("/(auth)/signup")} style={styles.navBtn} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: theme.spacing.lg,
    justifyContent: "center",
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
  inputError: { borderColor: theme.colors.error },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
});
