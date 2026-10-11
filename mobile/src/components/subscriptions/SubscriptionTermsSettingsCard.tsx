import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { useAppAlert } from "../../context/AppAlertContext";
import { supabase } from "../../lib/supabase";
import { AppText } from "../AppText";
import { AppSwitch } from "../AppSwitch";
import { Skeleton } from "../Skeleton";
import { rowFlipFor } from "../../lib/layoutDirection";
import {
  rpcGetSubscriptionTermsSettings,
  rpcSetSubscriptionTermsEnforced,
  termsTextFor,
  type SubscriptionTermsSettings,
} from "../../lib/subscriptionTerms";

/**
 * Setup → Legal: the subscription-terms switch (manager-only server-side). Ships OFF; the current document is a draft
 * until business/legal approval, so turning it on asks the manager to confirm that approval explicitly.
 */
export function SubscriptionTermsSettingsCard() {
  const { t, language, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const [settings, setSettings] = useState<SubscriptionTermsSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showText, setShowText] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpcGetSubscriptionTermsSettings(supabase);
      setSettings(res.ok ? res : null);
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(next: boolean) {
    setSaving(true);
    try {
      const res = await rpcSetSubscriptionTermsEnforced(supabase, next);
      if (!res.ok) throw new Error(res.error);
      showToast({ message: t("common.saved"), variant: "success" });
    } catch {
      showToast({ message: t("common.failed"), variant: "error" });
    } finally {
      setSaving(false);
      await load();
    }
  }

  function onToggle(next: boolean) {
    if (!settings || saving) return;
    const v = String(settings.document?.version ?? "");
    showConfirm({
      title: t(next ? "managerSubscriptionTerms.enableTitle" : "managerSubscriptionTerms.disableTitle"),
      message: t(next ? "managerSubscriptionTerms.enableBody" : "managerSubscriptionTerms.disableBody").replace("{v}", v),
      cancelLabel: t("common.cancel"),
      confirmLabel: t(next ? "managerSubscriptionTerms.enableConfirm" : "managerSubscriptionTerms.disableConfirm"),
      confirmVariant: next ? "primary" : "danger",
      onConfirm: () => void apply(next),
    });
  }

  if (loading) return <Skeleton height={140} style={styles.skeleton} />;
  if (!settings) return null;

  const doc = settings.document;
  const text = doc ? termsTextFor(doc, language) : null;
  const c = settings.counts;

  return (
    <View style={styles.card}>
      <AppText variant="title" isRTL={isRTL} style={styles.title}>
        {t("managerSubscriptionTerms.title")}
      </AppText>
      <AppText variant="body" isRTL={isRTL} style={styles.status}>
        {t(settings.enforced ? "managerSubscriptionTerms.statusOn" : "managerSubscriptionTerms.statusOff")}
      </AppText>
      {!settings.enforced ? (
        <View style={styles.notice}>
          <AppText variant="caption" isRTL={isRTL} style={styles.noticeTxt}>
            {t("managerSubscriptionTerms.approvalNotice")}
          </AppText>
        </View>
      ) : null}

      {doc ? (
        <>
          <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.toggleRowRtl]}>
            <AppText variant="body" isRTL={isRTL} style={styles.toggleLabel}>
              {t("managerSubscriptionTerms.switchLabel")}
            </AppText>
            <AppSwitch
              value={settings.enforced}
              onValueChange={onToggle}
              onColor={theme.colors.success}
              accessibilityLabel={t("managerSubscriptionTerms.switchLabel")}
              disabled={saving}
            />
          </View>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("managerSubscriptionTerms.scope")}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("managerSubscriptionTerms.version").replace("{v}", String(doc.version))}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("managerSubscriptionTerms.counts")
              .replace("{accepted}", String((c.accepted ?? 0) + (c.update_available ?? 0)))
              .replace("{pending}", String(c.pending ?? 0))
              .replace("{legacy}", String(c.legacy_pending ?? 0))}
          </AppText>
          <Pressable
            onPress={() => setShowText((v) => !v)}
            style={({ pressed }) => [styles.textToggle, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityState={{ expanded: showText }}
          >
            <AppText variant="body" style={styles.textToggleTxt}>
              {t(showText ? "managerSubscriptionTerms.hideText" : "managerSubscriptionTerms.showText")}
            </AppText>
          </Pressable>
          {showText && text ? (
            <View style={styles.docBox}>
              <AppText variant="title" isRTL={isRTL} style={styles.docTitle}>
                {text.title}
              </AppText>
              <AppText variant="body" isRTL={isRTL} style={styles.docBody}>
                {text.body}
              </AppText>
            </View>
          ) : null}
        </>
      ) : (
        <AppText variant="caption" muted isRTL={isRTL}>
          {t("managerSubscriptionTerms.noDocument")}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: { margin: theme.spacing.md, borderRadius: theme.radius.lg },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  title: { marginBottom: theme.spacing.xs },
  status: { marginBottom: theme.spacing.sm, lineHeight: 21 },
  notice: {
    backgroundColor: theme.colors.warningBg,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  noticeTxt: { color: theme.colors.text, lineHeight: 18 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm, minHeight: 44 },
  toggleRowRtl: { flexDirection: "row-reverse" },
  toggleLabel: { flex: 1 },
  meta: { marginTop: theme.spacing.xs, lineHeight: 18 },
  textToggle: { minHeight: 44, justifyContent: "center", marginTop: theme.spacing.xs },
  textToggleTxt: { color: theme.colors.cta, fontWeight: "800" },
  docBox: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    padding: theme.spacing.md,
  },
  docTitle: { marginBottom: theme.spacing.sm },
  docBody: { lineHeight: 22 },
});
