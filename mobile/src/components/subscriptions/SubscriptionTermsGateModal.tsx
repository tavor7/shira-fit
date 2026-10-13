import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useInertSiblings } from "../../hooks/useInertSiblings";
import { useSubscriptionTermsGate } from "../../hooks/useSubscriptionTermsGate";
import { supabase } from "../../lib/supabase";
import { rowFlipFor } from "../../lib/layoutDirection";
import { rpcAcceptSubscriptionTerms, termsTextFor } from "../../lib/subscriptionTerms";
import { AppText } from "../AppText";
import { SubscriptionTermsDocumentView } from "./SubscriptionTermsDocumentView";
import { LanguageToggleChip } from "../LanguageToggleChip";

/**
 * Mandatory subscription-terms screen. Rendered as an overlay inside (app)/_layout.tsx (same pattern as
 * LegalConsentGateModal): it covers every route, so navigating, browser Back or a deep link cannot get past it, and the
 * rest of the screen is made inert for keyboard / screen-reader users. It has no close, skip or cancellation action -
 * only reading, the unchecked-by-default consent checkbox, accepting, switching language and logging out (essential
 * authentication). Being unable to close it is never consent: only the athlete's own accept_subscription_terms call
 * records it, and the server also refuses the athlete's own registrations while acceptance is pending.
 * Stacked below LegalConsentGateModal (Terms of Use / Privacy), which is accepted first when both apply.
 */
export function SubscriptionTermsGateModal() {
  const { session, signOut } = useAuth();
  const { t, language, isRTL } = useI18n();
  const { showToast } = useToast();
  const { loading, document, reload } = useSubscriptionTermsGate();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const overlayRef = useRef<View>(null);
  const shown = !!session && !loading && !!document;
  useInertSiblings(overlayRef, shown);

  useEffect(() => {
    // A new document version always starts unchecked.
    setChecked(false);
    setError("");
  }, [document?.version]);

  if (!shown || !document) return null;
  const { title, body } = termsTextFor(document, language);

  async function accept() {
    if (!checked || submitting || !document) return;
    setSubmitting(true);
    setError("");
    try {
      const ua = Platform.OS === "web" && typeof navigator !== "undefined" ? navigator.userAgent : `${Platform.OS} app`;
      const res = await rpcAcceptSubscriptionTerms(supabase, document.version, ua);
      if (res.ok) {
        showToast({ message: t("subscriptionTerms.acceptedToast"), variant: "success" });
      } else {
        setError(t(res.error === "version_mismatch" ? "subscriptionTerms.versionChanged" : "subscriptionTerms.acceptError"));
      }
      await reload();
    } catch {
      setError(t("subscriptionTerms.acceptError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View
      ref={overlayRef}
      style={styles.overlay}
      accessibilityViewIsModal
      {...(Platform.OS === "web" ? { role: "dialog", "aria-modal": true, "aria-label": title } : null)}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboard}>
        <View style={styles.card}>
          <SubscriptionTermsDocumentView
            title={title}
            body={body}
            version={document.version}
            isRTL={isRTL}
            t={t}
            checked={checked}
            onToggle={() => setChecked((v) => !v)}
            onAccept={() => void accept()}
            accepting={submitting}
            error={error}
            fill
            header={
              <View style={[styles.topRow, rowFlipFor(isRTL) && styles.topRowRtl]}>
                <LanguageToggleChip />
                <Pressable
                  onPress={() => void signOut()}
                  disabled={submitting}
                  style={({ pressed }) => [styles.logout, pressed && { opacity: 0.8 }]}
                  accessibilityRole="button"
                >
                  <AppText variant="label" style={styles.logoutTxt}>
                    {t("header.logout")}
                  </AppText>
                </Pressable>
              </View>
            }
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.colors.backgroundAlt,
    zIndex: 9990,
  },
  // Bottom space keeps the Accept button clear of the global accessibility button.
  keyboard: { flex: 1, justifyContent: "center", padding: theme.spacing.md, paddingBottom: 84 },
  card: {
    width: "100%",
    maxWidth: 560,
    // Full available height (capped on large screens) so the terms text gets as much room as possible.
    height: "100%",
    maxHeight: 860,
    alignSelf: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
  },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.spacing.sm },
  topRowRtl: { flexDirection: "row-reverse" },
  logout: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.sm },
  logoutTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});
