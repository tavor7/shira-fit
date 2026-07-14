import { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, Stack } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { LoadingState } from "../../src/components/LoadingState";
import { useI18n } from "../../src/context/I18nContext";
import { NotificationSettingsPanel } from "../../src/components/NotificationSettingsPanel";
import { ManagerSendMessagePanel } from "../../src/components/ManagerSendMessagePanel";

function getUpdateErrorMessage(message: string, t: (key: string) => string) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return t("profile.emailInUse");
  }
  if (msg.includes("invalid") && msg.includes("email")) return t("profile.emailInvalid");
  return message || t("profile.updateFailed");
}

type Segment = "account" | "notifications" | "messages";

export default function ProfileScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const { session, profile, refreshProfile } = useAuth();
  const { t, isRTL } = useI18n();

  const [segment, setSegment] = useState<Segment>(() => {
    if (tab === "notifications") return "notifications";
    if (tab === "messages") return "messages";
    return "account";
  });

  useEffect(() => {
    if (tab === "notifications") setSegment("notifications");
    else if (tab === "messages") setSegment("messages");
  }, [tab]);

  const initialEmail = session?.user?.email ?? "";
  const initialPhone = profile?.phone ?? "";
  const initialAddress = profile?.address ?? "";
  const initialZipCode = profile?.zip_code ?? "";

  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [address, setAddress] = useState(initialAddress);
  const [zipCode, setZipCode] = useState(initialZipCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  useEffect(() => {
    setEmail(initialEmail);
    setPhone(initialPhone);
    setAddress(initialAddress);
    setZipCode(initialZipCode);
  }, [initialEmail, initialPhone, initialAddress, initialZipCode]);

  const canSave = useMemo(() => {
    return (
      !!session?.user?.id &&
      email.trim().length > 0 &&
      phone.trim().length > 0 &&
      address.trim().length > 0 &&
      zipCode.trim().length > 0 &&
      !busy
    );
  }, [session?.user?.id, email, phone, address, zipCode, busy]);

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
    const addressTrim = address.trim();
    const zipTrim = zipCode.trim();

    if (!emailTrim) {
      setError(t("profile.emailRequired"));
      return;
    }
    if (!phoneTrim) {
      setError(t("profile.phoneRequired"));
      return;
    }
    if (!addressTrim) {
      setError(t("profile.addressRequired"));
      return;
    }
    if (!zipTrim) {
      setError(t("profile.zipCodeRequired"));
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

      const { error: profileErr } = await supabase
        .from("profiles")
        .update({ phone: phoneTrim, address: addressTrim, zip_code: zipTrim })
        .eq("user_id", uid);

      if (profileErr) {
        setError(profileErr.message);
        return;
      }

      await refreshProfile();
      if (Platform.OS === "ios" || Platform.OS === "android") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setSuccess(t("common.saved"));
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSuccess(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  const showLoading = !session || !profile;
  if (showLoading) {
    return (
      <View style={styles.loadingWrap}>
        <Stack.Screen options={{ title: t("screen.profile") }} />
        <LoadingState label={t("common.loading")} isRTL={isRTL} />
      </View>
    );
  }

  const rtl = isRTL;
  const isManager = profile.role === "manager";

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
          {isManager ? (
            <Pressable
              onPress={() => setSegment("messages")}
              style={({ pressed }) => [
                styles.segmentSlot,
                segment === "messages" && styles.segmentSlotActive,
                pressed && segment !== "messages" && styles.segmentSlotPressed,
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: segment === "messages" }}
            >
              <AppText
                variant="caption"
                style={[styles.segmentTxt, segment === "messages" && styles.segmentTxtActive]}
                numberOfLines={1}
                maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
              >
                {t("profile.tabMessages")}
              </AppText>
            </Pressable>
          ) : null}
        </View>

        {segment === "account" ? (
          <>
            {success ? (
              <View style={styles.successBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <AppText isRTL={rtl} style={styles.successText}>
                  {success}
                </AppText>
              </View>
            ) : null}
            {error ? (
              <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <AppText isRTL={rtl} style={styles.errorText}>
                  {error}
                </AppText>
              </View>
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
            {email.trim() !== initialEmail ? (
              <AppText variant="caption" isRTL={rtl} style={styles.emailWarning}>
                {t("profile.emailChangeWarning")}
              </AppText>
            ) : null}

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

            <AppTextField
              label={t("profile.address")}
              value={address}
              onChangeText={(v) => {
                setAddress(v);
                setError(null);
                setSuccess(null);
              }}
              autoCapitalize="words"
              placeholder={t("profile.address")}
              isRTL={rtl}
              variant="dark"
              containerStyle={styles.field}
            />

            <AppTextField
              label={t("profile.zipCode")}
              value={zipCode}
              onChangeText={(v) => {
                setZipCode(v);
                setError(null);
                setSuccess(null);
              }}
              keyboardType="number-pad"
              placeholder={t("profile.zipCode")}
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
        ) : segment === "messages" && isManager ? (
          <ManagerSendMessagePanel />
        ) : (
          <NotificationSettingsPanel variant="embedded" />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.backgroundAlt },
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
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error, fontWeight: "600" },
  successBox: {
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: theme.colors.success,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  successText: { color: theme.colors.success, fontWeight: "700" },
  emailWarning: { color: theme.colors.warning, marginTop: -theme.spacing.sm, marginBottom: theme.spacing.md },
});
