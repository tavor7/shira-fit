import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { fetchAddressCollectionRequired } from "../lib/addressCollection";
import { fetchRequiredConsents } from "../lib/consent";
import { supabase } from "../lib/supabase";
import { PrimaryButton } from "./PrimaryButton";

export function AddressGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const [loading, setLoading] = useState(true);
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [fieldError, setFieldError] = useState("");

  const load = useCallback(async () => {
    if (!session?.user?.id) {
      setRequired(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const consents = await fetchRequiredConsents();
      if (consents.some((c) => c.consent_type === "electronic_receipts")) {
        setRequired(false);
        return;
      }
      setRequired(await fetchAddressCollectionRequired());
    } catch {
      setRequired(false);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void load();
  }, [load, profile?.address, profile?.zip_code]);

  useEffect(() => {
    setAddress(profile?.address?.trim() ?? "");
    setZipCode(profile?.zip_code?.trim() ?? "");
  }, [profile?.address, profile?.zip_code]);

  if (!session || loading || !required) return null;

  async function save() {
    const addr = address.trim();
    const zip = zipCode.trim();
    if (!addr || !zip) {
      setFieldError(
        language === "he" ? "יש למלא כתובת ומיקוד לפני המשך." : "Please enter your address and zip code to continue.",
      );
      return;
    }
    setFieldError("");
    setBusy(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ address: addr, zip_code: zip })
        .eq("user_id", session!.user.id);
      if (error) {
        setFieldError(error.message);
        return;
      }
      await refreshProfile();
      setRequired(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={[styles.title, isRTL && styles.rtl]}>
          {language === "he" ? "עדכון כתובת" : "Update your address"}
        </Text>
        <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent}>
          <Text style={[styles.body, isRTL && styles.rtl]}>
            {language === "he"
              ? "נדרשת כתובת ומיקוד לצורך הפקת קבלות. אנא מלא/י את הפרטים להמשך."
              : "A street address and zip code are required for receipts. Please fill them in to continue."}
          </Text>
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
        </ScrollView>
        {fieldError ? <Text style={[styles.fieldError, isRTL && styles.rtl]}>{fieldError}</Text> : null}
        <PrimaryButton
          label={language === "he" ? "שמירה והמשך" : "Save and continue"}
          onPress={() => void save()}
          disabled={busy}
        />
        {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={theme.colors.cta} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.overlay.backdrop,
    zIndex: 9998,
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
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
