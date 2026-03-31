import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { PrimaryButton } from "../../src/components/PrimaryButton";

function getUpdateErrorMessage(message: string) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return "This email is already in use. Try another one.";
  }
  if (msg.includes("invalid") && msg.includes("email")) return "Invalid email format.";
  return message || "Update failed. Please try again.";
}

export default function ProfileScreen() {
  const { session, profile, refreshProfile } = useAuth();

  const initialEmail = session?.user?.email ?? "";
  const initialPhone = profile?.phone ?? "";

  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setEmail(initialEmail);
    setPhone(initialPhone);
  }, [initialEmail, initialPhone]);

  const canSave = useMemo(() => {
    return !!session?.user?.id && email.trim().length > 0 && phone.trim().length > 0 && !busy;
  }, [session?.user?.id, email, phone, busy]);

  async function save() {
    setError(null);
    setSuccess(null);

    const uid = session?.user?.id;
    if (!uid) {
      setError("Not authenticated.");
      return;
    }

    const emailTrim = email.trim();
    const phoneTrim = phone.trim();

    if (!emailTrim) {
      setError("Email is required.");
      return;
    }
    if (!phoneTrim) {
      setError("Phone is required.");
      return;
    }

    setBusy(true);
    try {
      // 1) Update email in Supabase Auth (uniqueness enforced by Supabase)
      if (emailTrim !== (session?.user?.email ?? "")) {
        const { error: emailErr } = await supabase.auth.updateUser({ email: emailTrim });
        if (emailErr) {
          setError(getUpdateErrorMessage(emailErr.message));
          return;
        }
      }

      // 2) Update phone in profiles
      const { error: phoneErr } = await supabase
        .from("profiles")
        .update({ phone: phoneTrim })
        .eq("user_id", uid);

      if (phoneErr) {
        setError(phoneErr.message);
        return;
      }

      await refreshProfile();
      setSuccess("Saved!");
    } finally {
      setBusy(false);
    }
  }

  const showLoading = !session || !profile;
  if (showLoading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>My info</Text>
        <Text style={styles.subtitle}>
          Loaded from your account ({profile.role}).
        </Text>

        {success ? <Text style={styles.success}>{success}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setError(null);
              setSuccess(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="Email"
            placeholderTextColor={theme.colors.textSoft}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Phone</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={(t) => {
              setPhone(t);
              setError(null);
              setSuccess(null);
            }}
            keyboardType="phone-pad"
            autoCapitalize="none"
            placeholder="Phone"
            placeholderTextColor={theme.colors.textSoft}
          />
        </View>

        <PrimaryButton
          label="Save changes"
          onPress={save}
          loading={busy}
          disabled={!canSave}
          loadingLabel="Saving…"
          style={{ marginTop: theme.spacing.lg }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.backgroundAlt },
  loadingText: { marginTop: 12, color: theme.colors.textMuted },
  scrollContent: { flexGrow: 1, padding: theme.spacing.lg },
  title: { fontSize: 22, fontWeight: "800", color: theme.colors.text },
  subtitle: { marginTop: 6, color: theme.colors.textMuted, marginBottom: theme.spacing.lg },
  field: { marginBottom: theme.spacing.md },
  label: { fontWeight: "700", color: theme.colors.textSoft, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 14,
    fontSize: 16,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  error: { color: theme.colors.error, marginBottom: theme.spacing.md, fontWeight: "600" },
  success: { color: theme.colors.success, marginBottom: theme.spacing.md, fontWeight: "700" },
});

