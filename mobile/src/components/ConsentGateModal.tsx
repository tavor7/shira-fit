import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { fetchRequiredConsents, recordUserConsent } from "../lib/consent";
import type { RequiredConsent } from "../lib/documents";
import { PrimaryButton } from "./PrimaryButton";

export function ConsentGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, isRTL } = useI18n();
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState<RequiredConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

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

  if (!session || loading) return null;
  if (!consent) return null;

  async function accept() {
    setBusy(true);
    try {
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
        </ScrollView>
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
  declined: { marginTop: theme.spacing.md, color: theme.colors.warning, fontSize: 14, fontWeight: "600" },
  actions: { marginTop: theme.spacing.lg, gap: theme.spacing.sm },
  actionsRtl: { alignItems: "stretch" },
  declineBtn: { paddingVertical: 12, alignItems: "center" },
  declineText: { color: theme.colors.textMuted, fontWeight: "700" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
