import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useReceiptRequirements } from "../hooks/useReceiptRequirements";
import { recordUserConsent } from "../lib/consent";
import { supabase } from "../lib/supabase";
import { PrimaryButton } from "./PrimaryButton";

export function ReceiptRequirementsGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const { loading, mode, consent, needsAddress, blocksApp, reload } = useReceiptRequirements();
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    setAddress(profile?.address?.trim() ?? "");
    setZipCode(profile?.zip_code?.trim() ?? "");
  }, [profile?.address, profile?.zip_code]);

  useEffect(() => {
    setDeclined(false);
    setFieldError("");
  }, [mode, consent?.version]);

  if (!session || loading || !blocksApp) return null;

  const showConsent = mode === "consent_only" || mode === "both";
  const showAddress = mode === "address_only" || mode === "both";

  const title =
    mode === "both"
      ? language === "he"
        ? "השלימו את הפרטים"
        : "Complete your details"
      : mode === "consent_only"
        ? consent!.title
        : language === "he"
          ? "עדכון כתובת"
          : "Update your address";

  const intro =
    mode === "both"
      ? language === "he"
        ? "כדי להמשיך להשתמש באפליקציה, יש לאשר את הסכמת קבלת המסמכים האלקטרוניים ולמלא כתובת ומיקוד."
        : "To continue using the app, please accept electronic receipt consent and provide your address and zip code."
      : mode === "address_only"
        ? language === "he"
          ? "נדרשת כתובת ומיקוד לצורך הפקת קבלות. אנא מלא/י את הפרטים להמשך."
          : "A street address and zip code are required for receipts. Please fill them in to continue."
        : null;

  async function saveAll() {
    if (showAddress) {
      const addr = address.trim();
      const zip = zipCode.trim();
      if (!addr || !zip) {
        setFieldError(
          language === "he" ? "יש למלא כתובת ומיקוד לפני המשך." : "Please enter your address and zip code to continue.",
        );
        return;
      }
    }
    setFieldError("");
    setBusy(true);
    try {
      if (showConsent && consent) {
        await recordUserConsent({
          consent_type: "electronic_receipts",
          status: "accepted",
          consent_version: consent.version,
        });
      }
      if (showAddress) {
        const { error } = await supabase
          .from("profiles")
          .update({ address: address.trim(), zip_code: zipCode.trim() })
          .eq("user_id", session!.user.id);
        if (error) {
          setFieldError(error.message);
          return;
        }
      }
      await refreshProfile();
      await reload();
    } catch {
      if (showConsent) setDeclined(true);
      else setFieldError(language === "he" ? "לא ניתן לשמור. נסו שוב." : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!consent) return;
    setBusy(true);
    try {
      await recordUserConsent({
        consent_type: "electronic_receipts",
        status: "declined",
        consent_version: consent.version,
      });
      setDeclined(true);
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel =
    mode === "consent_only"
      ? language === "he"
        ? "אני מסכים/ה"
        : "I agree"
      : language === "he"
        ? "שמירה והמשך"
        : "Save and continue";

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{title}</Text>
        <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          {intro ? <Text style={[styles.body, isRTL && styles.rtl]}>{intro}</Text> : null}
          {showConsent && consent ? (
            <View style={mode === "both" ? styles.section : undefined}>
              {mode === "both" ? (
                <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>
                  {language === "he" ? "הסכמה לקבלת מסמכים" : "Electronic receipt consent"}
                </Text>
              ) : null}
              {mode === "consent_only" ? null : (
                <Text style={[styles.consentTitle, isRTL && styles.rtl]}>{consent.title}</Text>
              )}
              <Text style={[styles.body, isRTL && styles.rtl]}>{consent.body_text}</Text>
            </View>
          ) : null}
          {showAddress ? (
            <View style={[styles.addressBlock, mode === "both" && styles.section]}>
              {mode === "both" ? (
                <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>
                  {language === "he" ? "כתובת למשלוח מסמכים" : "Billing address"}
                </Text>
              ) : null}
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
        {declined ? (
          <Text style={[styles.declined, isRTL && styles.rtl]}>
            {language === "he"
              ? "הסכמה לקבלת מסמכים אלקטרוניים נדרשת לשימוש במערכת. אנא אשר/י את ההסכמה כדי להמשיך."
              : "Electronic receipt consent is required to use the app. Please accept to continue."}
          </Text>
        ) : null}
        {fieldError ? <Text style={[styles.fieldError, isRTL && styles.rtl]}>{fieldError}</Text> : null}
        <View style={[styles.actions, isRTL && styles.actionsRtl]}>
          <PrimaryButton label={primaryLabel} onPress={() => void saveAll()} disabled={busy || declined} />
          {showConsent ? (
            <Pressable
              onPress={() => void decline()}
              disabled={busy}
              style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.declineText}>{language === "he" ? "לא מסכים/ה" : "Decline"}</Text>
            </Pressable>
          ) : null}
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
    maxHeight: "90%",
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: theme.spacing.md },
  bodyScroll: { maxHeight: 420 },
  bodyContent: { paddingBottom: theme.spacing.sm, gap: theme.spacing.md },
  body: { fontSize: 15, lineHeight: 22, color: theme.colors.textMuted },
  section: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    gap: theme.spacing.sm,
  },
  sectionLabel: { fontSize: 13, fontWeight: "800", color: theme.colors.text, textTransform: "uppercase", letterSpacing: 0.3 },
  consentTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  addressBlock: { gap: theme.spacing.xs },
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
