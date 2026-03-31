import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useI18n } from "../../src/context/I18nContext";

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
  const { language, t, isRTL } = useI18n();

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
      setError(language === "he" ? "לא מחובר/ת." : "Not authenticated.");
      return;
    }

    const emailTrim = email.trim();
    const phoneTrim = phone.trim();

    if (!emailTrim) {
      setError(language === "he" ? "נדרש אימייל." : "Email is required.");
      return;
    }
    if (!phoneTrim) {
      setError(language === "he" ? "נדרש טלפון." : "Phone is required.");
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
      setSuccess(language === "he" ? "נשמר!" : "Saved!");
    } finally {
      setBusy(false);
    }
  }

  const showLoading = !session || !profile;
  if (showLoading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.loadingText, isRTL && { textAlign: "right" }]}>{t("common.loading")}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, isRTL && { textAlign: "right" }]}>{language === "he" ? "הפרטים שלי" : "My info"}</Text>
        <Text style={[styles.subtitle, isRTL && { textAlign: "right" }]}>
          {language === "he" ? `נטען מהחשבון שלך (${profile.role}).` : `Loaded from your account (${profile.role}).`}
        </Text>

        {success ? <Text style={styles.success}>{success}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.field}>
          <Text style={[styles.label, isRTL && { textAlign: "right" }]}>{t("auth.email")}</Text>
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
            placeholder={t("auth.email")}
            placeholderTextColor={theme.colors.textSoft}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, isRTL && { textAlign: "right" }]}>{t("profile.phone")}</Text>
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
            placeholder={t("profile.phone")}
            placeholderTextColor={theme.colors.textSoft}
          />
        </View>

        <PrimaryButton
          label={language === "he" ? "שמירת שינויים" : "Save changes"}
          onPress={save}
          loading={busy}
          disabled={!canSave}
          loadingLabel={t("common.loading")}
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

