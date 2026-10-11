import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { AppText } from "../AppText";
import { AnimatedCheckMark } from "../AnimatedCheckMark";
import { PrimaryButton } from "../PrimaryButton";
import { rowFlipFor } from "../../lib/layoutDirection";
import { rpcAcceptSubscriptionTerms, termsTextFor, type SubscriptionTermsDocument } from "../../lib/subscriptionTerms";

type Props = {
  visible: boolean;
  document: SubscriptionTermsDocument;
  onClose: () => void;
  /** Called after the server recorded the acceptance (or the terms changed underneath and must be reloaded). */
  onDone: (result: "accepted" | "version_changed") => void;
};

/**
 * The athlete reads the full subscription terms (scrollable) and explicitly accepts them: the checkbox starts unchecked
 * every time the dialog opens and the accept button stays disabled until it is ticked. Only the athlete's own session can
 * accept (accept_subscription_terms uses auth.uid() and validates the version server-side).
 */
export function SubscriptionTermsModal({ visible, document, onClose, onDone }: Props) {
  const { t, language, isRTL } = useI18n();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { title, body } = termsTextFor(document, language);

  useEffect(() => {
    if (visible) {
      setChecked(false);
      setError("");
    }
  }, [visible, document.version]);

  async function accept() {
    if (!checked || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const ua = Platform.OS === "web" && typeof navigator !== "undefined" ? navigator.userAgent : `${Platform.OS} app`;
      const res = await rpcAcceptSubscriptionTerms(supabase, document.version, ua);
      if (res.ok) {
        onDone("accepted");
      } else if (res.error === "version_mismatch") {
        setError(t("subscriptionTerms.versionChanged"));
        onDone("version_changed");
      } else {
        setError(t("subscriptionTerms.acceptError"));
      }
    } catch {
      setError(t("subscriptionTerms.acceptError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppModal
      visible={visible}
      onClose={() => (submitting ? null : onClose())}
      variant="dialog"
      backdropAccessibilityLabel={t("common.cancel")}
      maxHeightPct={0.9}
      cardStyle={styles.card}
    >
      <AppText variant="headline" isRTL={isRTL} accessibilityRole="header" style={styles.title}>
        {title}
      </AppText>
      <AppText variant="caption" muted isRTL={isRTL} style={styles.version}>
        {t("subscriptionTerms.version").replace("{v}", String(document.version))}
      </AppText>
      <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator>
        <AppText variant="body" isRTL={isRTL} style={styles.body}>
          {body}
        </AppText>
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.checkRow, rowFlipFor(isRTL) && styles.checkRowRtl, pressed && { opacity: 0.9 }]}
        onPress={() => setChecked((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        aria-checked={checked}
        accessibilityLabel={t("subscriptionTerms.checkbox")}
      >
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          <AnimatedCheckMark visible={checked} style={styles.checkboxMark} />
        </View>
        <AppText variant="body" isRTL={isRTL} style={styles.checkTxt}>
          {t("subscriptionTerms.checkbox")}
        </AppText>
      </Pressable>

      {error ? (
        <AppText variant="caption" isRTL={isRTL} style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <PrimaryButton
        label={t("subscriptionTerms.accept")}
        loadingLabel={t("common.loading")}
        loading={submitting}
        disabled={!checked}
        onPress={() => void accept()}
      />
      <Pressable
        onPress={onClose}
        disabled={submitting}
        style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
      >
        <AppText variant="label" style={styles.cancelTxt}>
          {t("common.cancel")}
        </AppText>
      </Pressable>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { maxWidth: 560, padding: theme.spacing.lg },
  title: { marginBottom: 2 },
  version: { marginBottom: theme.spacing.sm },
  bodyScroll: {
    flexGrow: 0,
    maxHeight: 380,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    marginBottom: theme.spacing.md,
  },
  bodyContent: { padding: theme.spacing.md },
  body: { lineHeight: 22 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, minHeight: 44, marginBottom: theme.spacing.sm },
  checkRowRtl: { flexDirection: "row-reverse" },
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
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 13 },
  checkTxt: { flex: 1 },
  error: { color: theme.colors.error, marginBottom: theme.spacing.sm },
  cancel: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: theme.spacing.xs },
  cancelTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});
