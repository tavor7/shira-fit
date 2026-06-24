import { useEffect, useMemo, useState } from "react";
import { View, StyleSheet, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { useI18n } from "../../src/context/I18nContext";
import { NotificationSettingsPanel } from "../../src/components/NotificationSettingsPanel";

function getUpdateErrorMessage(message: string, t: (key: string) => string) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return t("profile.emailInUse");
  }
  if (msg.includes("invalid") && msg.includes("email")) return t("profile.emailInvalid");
  return message || t("profile.updateFailed");
}

type Segment = "account" | "notifications";

export default function ProfileScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const { session, profile, refreshProfile } = useAuth();
  const { t, isRTL } = useI18n();

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
      setError(t("profile.notAuthenticated"));
      return;
    }

    const emailTrim = email.trim();
    const phoneTrim = phone.trim();

    if (!emailTrim) {
      setError(t("profile.emailRequired"));
      return;
    }
    if (!phoneTrim) {
      setError(t("profile.phoneRequired"));
      return;
    }

    setBusy(true);
    try {
      if (emailTrim !== (session?.user?.email ?? "")) {
        const { error: emailErr } = await supabase.auth.updateUser({ email: emailTrim });
        if (emailErr) {
          setError(getUpdateErrorMessage(emailErr.message, t));
          return;
        }
      }

      const { error: phoneErr } = await supabase.from("profiles").update({ phone: phoneTrim }).eq("user_id", uid);

      if (phoneErr) {
        setError(phoneErr.message);
        return;
      }

      await refreshProfile();
      setSuccess(t("common.saved"));
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
        <AppText muted isRTL={isRTL} style={styles.loadingText}>
          {t("common.loading")}
        </AppText>
      </View>
    );
  }

  const rtl = isRTL;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}
    >
      <Stack.Screen options={{ title: t("screen.profile") }} />
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <AppText variant="display" isRTL={rtl}>
          {t("profile.selfTitle")}
        </AppText>
        <AppText muted isRTL={rtl} style={styles.subtitle}>
          {t("profile.selfSubtitle").replace("{role}", profile.role)}
        </AppText>

        <View style={[styles.segmentTrack, rtl && styles.segmentTrackRtl]} accessibilityRole="tablist">
          <Pressable
            onPress={() => setSegment("account")}
            style={({ pressed }) => [
              styles.segmentSlot,
              segment === "account" && styles.segmentSlotActive,
              pressed && segment !== "account" && styles.segmentSlotPressed,
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === "account" }}
          >
            <AppText
              variant="caption"
              style={[styles.segmentTxt, segment === "account" && styles.segmentTxtActive]}
              numberOfLines={1}
              maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
            >
              {t("profile.tabAccount")}
            </AppText>
          </Pressable>
          <Pressable
            onPress={() => setSegment("notifications")}
            style={({ pressed }) => [
              styles.segmentSlot,
              segment === "notifications" && styles.segmentSlotActive,
              pressed && segment !== "notifications" && styles.segmentSlotPressed,
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === "notifications" }}
          >
            <AppText
              variant="caption"
              style={[styles.segmentTxt, segment === "notifications" && styles.segmentTxtActive]}
              numberOfLines={1}
              maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
            >
              {t("profile.tabNotifications")}
            </AppText>
          </Pressable>
        </View>

        {segment === "account" ? (
          <>
            {success ? (
              <AppText isRTL={rtl} style={styles.success}>
                {success}
              </AppText>
            ) : null}
            {error ? (
              <AppText isRTL={rtl} style={styles.error}>
                {error}
              </AppText>
            ) : null}

            <AppTextField
              label={t("auth.email")}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                setError(null);
                setSuccess(null);
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              placeholder={t("auth.email")}
              isRTL={rtl}
              variant="dark"
              containerStyle={styles.field}
            />

            <AppTextField
              label={t("profile.phone")}
              value={phone}
              onChangeText={(v) => {
                setPhone(v);
                setError(null);
                setSuccess(null);
              }}
              keyboardType="phone-pad"
              autoCapitalize="none"
              placeholder={t("profile.phone")}
              isRTL={rtl}
              variant="dark"
              containerStyle={styles.field}
            />

            <PrimaryButton
              label={t("profile.saveChanges")}
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
  loadingText: { marginTop: theme.spacing.sm },
  scrollContent: { flexGrow: 1, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl },
  subtitle: { marginTop: theme.spacing.xs, marginBottom: theme.spacing.md },
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
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  segmentSlotActive: {
    backgroundColor: theme.colors.cta,
  },
  segmentSlotPressed: {
    opacity: 0.85,
  },
  segmentTxt: {
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.2,
  },
  segmentTxtActive: {
    color: theme.colors.ctaText,
  },
  field: { marginBottom: theme.spacing.md },
  error: { color: theme.colors.error, marginBottom: theme.spacing.md, fontWeight: "600" },
  success: { color: theme.colors.success, marginBottom: theme.spacing.md, fontWeight: "700" },
});
