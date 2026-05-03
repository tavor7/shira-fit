import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useI18n } from "../../src/context/I18nContext";
import { NotificationSettingsPanel } from "../../src/components/NotificationSettingsPanel";

function getUpdateErrorMessage(message: string) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return "This email is already in use. Try another one.";
  }
  if (msg.includes("invalid") && msg.includes("email")) return "Invalid email format.";
  return message || "Update failed. Please try again.";
}

type Segment = "account" | "notifications";

export default function ProfileScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();

  const [segment, setSegment] = useState<Segment>(() => (tab === "notifications" ? "notifications" : "account"));

  useEffect(() => {
    if (tab === "notifications") setSegment("notifications");
  }, [tab]);

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
      if (emailTrim !== (session?.user?.email ?? "")) {
        const { error: emailErr } = await supabase.auth.updateUser({ email: emailTrim });
        if (emailErr) {
          setError(getUpdateErrorMessage(emailErr.message));
          return;
        }
      }

      const { error: phoneErr } = await supabase.from("profiles").update({ phone: phoneTrim }).eq("user_id", uid);

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
        <Stack.Screen options={{ title: t("screen.profile") }} />
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.loadingText, isRTL && { textAlign: "right" }]}>{t("common.loading")}</Text>
      </View>
    );
  }

  const rtl = isRTL;
  const accountLabel = language === "he" ? "פרטים" : "Account";
  const notifLabel = language === "he" ? "התראות" : "Notifications";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}
    >
      <Stack.Screen options={{ title: t("screen.profile") }} />
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, rtl && { textAlign: "right" }]}>
          {language === "he" ? "פרופיל" : "Profile"}
        </Text>
        <Text style={[styles.subtitle, rtl && { textAlign: "right" }]}>
          {language === "he" ? `חשבון (${profile.role}).` : `Account (${profile.role}).`}
        </Text>

        <View style={[styles.segmentTrack, rtl && styles.segmentTrackRtl]}>
          <Pressable
            onPress={() => setSegment("account")}
            style={({ pressed }) => [
              styles.segmentSlot,
              segment === "account" && styles.segmentSlotActive,
              pressed && segment !== "account" && styles.segmentSlotPressed,
            ]}
          >
            <Text style={[styles.segmentTxt, segment === "account" && styles.segmentTxtActive]} numberOfLines={1}>
              {accountLabel}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSegment("notifications")}
            style={({ pressed }) => [
              styles.segmentSlot,
              segment === "notifications" && styles.segmentSlotActive,
              pressed && segment !== "notifications" && styles.segmentSlotPressed,
            ]}
          >
            <Text style={[styles.segmentTxt, segment === "notifications" && styles.segmentTxtActive]} numberOfLines={1}>
              {notifLabel}
            </Text>
          </Pressable>
        </View>

        {segment === "account" ? (
          <>
            {success ? <Text style={styles.success}>{success}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.field}>
              <Text style={[styles.label, rtl && { textAlign: "right" }]}>{t("auth.email")}</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={(v) => {
                  setEmail(v);
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
              <Text style={[styles.label, rtl && { textAlign: "right" }]}>{t("profile.phone")}</Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={(v) => {
                  setPhone(v);
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
          </>
        ) : (
          <NotificationSettingsPanel variant="embedded" />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.backgroundAlt },
  loadingText: { marginTop: 12, color: theme.colors.textMuted },
  scrollContent: { flexGrow: 1, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl },
  title: { fontSize: 22, fontWeight: "800", color: theme.colors.text },
  subtitle: { marginTop: 6, color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  segmentTrack: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.full,
    padding: 4,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.lg,
    gap: 4,
  },
  segmentTrackRtl: { flexDirection: "row-reverse" },
  segmentSlot: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentSlotActive: {
    backgroundColor: theme.colors.cta,
  },
  segmentSlotPressed: {
    opacity: 0.85,
  },
  segmentTxt: {
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.2,
  },
  segmentTxtActive: {
    color: theme.colors.ctaText,
  },
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
