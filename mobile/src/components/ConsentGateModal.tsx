import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { fetchRequiredConsents, recordUserConsent } from "../lib/consent";
import type { RequiredConsent } from "../lib/documents";
import { supabase } from "../lib/supabase";
import { PrimaryButton } from "./PrimaryButton";

export function ConsentGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState<RequiredConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [fieldError, setFieldError] = useState("");

  const needsAddress = !profile?.address?.trim() || !profile?.zip_code?.trim();

  const load = useCallback(async () => {
    if (!session?.user?.id) {
      setConsent(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const required = await fetchRequiredConsents();
      const er = required.find((c) => c.consent_type === "electronic_receipts") ?? null;
      setConsent(er);
      setDeclined(false);
    } catch {
      setConsent(null);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void load();
  }, [load, profile?.electronic_receipts_consent_version]);

  useEffect(() => {
    setAddress(profile?.address?.trim() ?? "");
    setZipCode(profile?.zip_code?.trim() ?? "");
  }, [profile?.address, profile?.zip_code]);

  if (!session || loading) return null;
  if (!consent) return null;

  async function saveAddressIfNeeded(): Promise<boolean> {
    if (!needsAddress) return true;
    const addr = address.trim();
    const zip = zipCode.trim();
    if (!addr || !zip) {
      setFieldError(
        language === "he" ? "יש למלא כתובת ומיקוד לפני המשך." : "Please enter your address and zip code to continue.",
      );
      return false;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ address: addr, zip_code: zip })
      .eq("user_id", session!.user.id);
    if (error) {
      setFieldError(error.message);
      return false;
    }
    await refreshProfile();
    return true;
  }

  async function accept() {
    setFieldError("");
    setBusy(true);
    try {
      if (!(await saveAddressIfNeeded())) return;
      await recordUserConsent({
        consent_type: "electronic_receipts",
        status: "accepted",
        consent_version: consent!.version,
      });
      await refreshProfile();
      setConsent(null);
    } catch {
      setDeclined(true);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await recordUserConsent({
        consent_type: "electronic_receipts",
        status: "declined",
        consent_version: consent!.version,
      });
      setDeclined(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{consent.title}</Text>
        <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent}>
          <Text style={[styles.body, isRTL && styles.rtl]}>{consent.body_text}</Text>
          {needsAddress ? (
            <View style={styles.addressBlock}>
              <Text style={[styles.fieldLabel, isRTL && styles.rtl]}>{t("profile.address")}</Text>
              <TextInput
                style={[styles.input, isRTL && styles.inputRtl]}
                value={address}
                onChangeText={(v) => {
                  setAddress(v);
                  setFieldError("");
                }}
                placeholder={t("profile.address")}
                placeholderTextColor={theme.colors.textSoft}
              />
              <Text style={[styles.fieldLabel, isRTL && styles.rtl]}>{t("profile.zipCode")}</Text>
              <TextInput
                style={[styles.input, isRTL && styles.inputRtl]}
                value={zipCode}
                onChangeText={(v) => {
                  setZipCode(v);
                  setFieldError("");
                }}
                placeholder={t("profile.zipCode")}
                placeholderTextColor={theme.colors.textSoft}
                keyboardType="number-pad"
              />
            </View>
          ) : null}
        </ScrollView>
        {fieldError ? <Text style={[styles.fieldError, isRTL && styles.rtl]}>{fieldError}</Text> : null}
        {declined ? (
          <Text style={[styles.declined, isRTL && styles.rtl]}>
            {language === "he"
              ? "הסכמה לקבלת מסמכים אלקטרוניים נדרשת לשימוש במערכת. אנא אשר/י את ההסכמה כדי להמשיך."
              : "Electronic receipt consent is required to use the app. Please accept to continue."}
          </Text>
        ) : null}
        <View style={[styles.actions, isRTL && styles.actionsRtl]}>
          <PrimaryButton
            label={language === "he" ? "אני מסכים/ה" : "I agree"}
            onPress={() => void accept()}
            disabled={busy}
          />
          <Pressable onPress={() => void decline()} disabled={busy} style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.declineText}>{language === "he" ? "לא מסכים/ה" : "Decline"}</Text>
          </Pressable>
        </View>
        {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={theme.colors.cta} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.overlay.backdrop,
    zIndex: 9999,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxHeight: "85%",
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: theme.spacing.md },
  bodyScroll: { maxHeight: 360 },
  bodyContent: { paddingBottom: theme.spacing.sm },
  body: { fontSize: 15, lineHeight: 22, color: theme.colors.textMuted },
  addressBlock: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.text, marginTop: theme.spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: theme.colors.text,
    backgroundColor: theme.colors.backgroundAlt,
  },
  inputRtl: { textAlign: "right" },
  fieldError: { marginTop: theme.spacing.sm, color: theme.colors.error, fontSize: 13, fontWeight: "600" },
  declined: { marginTop: theme.spacing.md, color: theme.colors.warning, fontSize: 14, fontWeight: "600" },
  actions: { marginTop: theme.spacing.lg, gap: theme.spacing.sm },
  actionsRtl: { alignItems: "stretch" },
  declineBtn: { paddingVertical: 12, alignItems: "center" },
  declineText: { color: theme.colors.textMuted, fontWeight: "700" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
