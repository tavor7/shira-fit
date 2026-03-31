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

/**
 * User lands here after clicking the email link (tokens in URL hash on web).
 * Supabase must have this redirect URL allowlisted.
 */
export default function ResetPasswordScreen() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web" && typeof window !== "undefined") {
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
      const { data } = await supabase.auth.getSession();
      if (!cancelled) setReady(true);
      if (!data.session && Platform.OS !== "web") {
        Alert.alert("Invalid or expired link", "Request a new reset email from Forgot password.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (password.length < 6) {
      Alert.alert("Password too short", "Use at least 6 characters.");
      return;
    }
    if (password !== password2) {
      Alert.alert("Mismatch", "Passwords do not match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) Alert.alert("Error", error.message);
    else router.replace("/(auth)/password-updated");
  }

  if (!ready)
    return (
      <View style={[styles.container, { justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <Text style={styles.title}>New password</Text>
      <Text style={styles.hint}>Choose a new password for your account.</Text>
      <TextInput
        style={styles.input}
        placeholder="New password (min 6)"
        placeholderTextColor={theme.colors.textSoft}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <TextInput
        style={styles.input}
        placeholder="Confirm password"
        placeholderTextColor={theme.colors.textSoft}
        secureTextEntry
        value={password2}
        onChangeText={setPassword2}
      />
      <PrimaryButton
        label="Update password"
        loadingLabel="Saving…"
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
