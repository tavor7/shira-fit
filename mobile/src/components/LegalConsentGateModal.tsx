import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useLegalConsentGate } from "../hooks/useLegalConsentGate";
import { recordUserConsent } from "../lib/consent";
import { AppText } from "./AppText";
import { AnimatedCheckMark } from "./AnimatedCheckMark";
import { PrimaryButton } from "./PrimaryButton";

const DOC_ROUTE: Record<string, string> = {
  terms_of_service: "/legal/terms",
  privacy_policy: "/legal/privacy",
};

/**
 * Existing-user mandatory re-consent gate for Terms of Use / Privacy Policy.
 * Rendered as an overlay (not a route redirect) inside (app)/_layout.tsx, matching the
 * existing ReceiptRequirementsGateModal pattern — no redirect loops, survives refresh,
 * and (unlike that modal) always offers a way out via logout.
 */
export function LegalConsentGateModal() {
  const { session, signOut } = useAuth();
  const { language, t, isRTL } = useI18n();
  const { loading, required, blocksApp, reload } = useLegalConsentGate();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // One checkbox covers every required document at once — no need to tick each
  // separately when Terms and Privacy are both pending. The documents themselves (title,
  // text, "View" link) are still each shown in full for transparency.
  const allChecked = required.length > 0 && checked;

  if (!session || loading || !blocksApp) return null;

  async function onAcceptAll() {
    if (!allChecked || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      for (const c of required) {
        await recordUserConsent({
          consent_type: c.consent_type as "terms_of_service" | "privacy_policy",
          status: "accepted",
          consent_version: c.version,
        });
      }
      await reload();
    } catch {
      setError(t("legalGate.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboard}>
        <View style={styles.cardWrap}>
          <ScrollView style={styles.card} contentContainerStyle={styles.cardContent}>
            <AppText variant="headline" isRTL={isRTL} style={styles.title} accessibilityRole="header">
              {t("legalGate.title")}
            </AppText>
            <AppText variant="body" muted isRTL={isRTL} style={styles.intro}>
              {t("legalGate.intro")}
            </AppText>

            {required.map((c) => {
              const key = `${c.consent_type}:${c.version}`;
              const title = language === "en" && c.title_en ? c.title_en : c.title;
              const body = language === "en" && c.body_text_en ? c.body_text_en : c.body_text;
              return (
                <View key={key} style={styles.docBlock}>
                  <View style={styles.docHeaderRow}>
                    <AppText variant="title" isRTL={isRTL} style={styles.docTitle}>
                      {title}
                    </AppText>
                    <Pressable
                      onPress={() => router.push((DOC_ROUTE[c.consent_type] ?? "/legal/terms") as never)}
                      hitSlop={8}
                    >
                      <AppText variant="caption" style={styles.viewLink}>
                        {t("legalGate.viewDocument")}
                      </AppText>
                    </Pressable>
                  </View>
                  <AppText variant="caption" muted isRTL={isRTL} style={styles.docBody}>
                    {body}
                  </AppText>
                </View>
              );
            })}

            <Pressable
              style={({ pressed }) => [styles.checkRow, pressed && { opacity: 0.9 }]}
              onPress={() => setChecked((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
            >
              <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                <AnimatedCheckMark visible={checked} style={styles.checkboxMark} />
              </View>
              <AppText variant="body" isRTL={isRTL} style={styles.checkTxt}>
                {required.length > 1 ? t("legalGate.acceptAllDocs") : t("legalGate.accept")}
              </AppText>
            </Pressable>

            {error ? (
              <AppText variant="caption" style={styles.errorTxt} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {error}
              </AppText>
            ) : null}
            {!allChecked ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.hintTxt}>
                {t("legalGate.mustAcceptAll")}
              </AppText>
            ) : null}

            <PrimaryButton
              label={t("legalGate.acceptAll")}
              loadingLabel={t("common.loading")}
              loading={submitting}
              disabled={!allChecked}
              onPress={onAcceptAll}
              style={styles.acceptBtn}
            />
            <Pressable onPress={() => void signOut()} style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.7 }]}>
              <AppText variant="caption" muted>
                {t("legalGate.logout")}
              </AppText>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.overlay.backdrop,
    zIndex: 10000,
  },
  keyboard: { flex: 1, justifyContent: "center", padding: theme.spacing.lg },
  cardWrap: { width: "100%", maxWidth: 480, maxHeight: "88%", alignSelf: "center" },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardContent: { padding: theme.spacing.lg },
  title: { marginBottom: theme.spacing.xs },
  intro: { marginBottom: theme.spacing.md, lineHeight: 21 },
  docBlock: {
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  docHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.spacing.xs },
  docTitle: { flex: 1 },
  viewLink: { color: theme.colors.cta, fontWeight: "700" },
  docBody: { marginBottom: theme.spacing.sm, lineHeight: 19 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  checkTxt: { flex: 1 },
  errorTxt: { color: theme.colors.error, marginBottom: theme.spacing.sm },
  hintTxt: { marginBottom: theme.spacing.sm },
  acceptBtn: { marginTop: theme.spacing.xs },
  logoutBtn: { alignSelf: "center", padding: theme.spacing.sm, marginTop: theme.spacing.xs },
});
