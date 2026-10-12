import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { supabase } from "../../lib/supabase";
import { AppText } from "../AppText";
import { PrimaryButton } from "../PrimaryButton";
import { Skeleton } from "../Skeleton";
import { rpcGetSubscriptionTermsAdmin, type SubscriptionTermsAdmin } from "../../lib/subscriptionTerms";

/**
 * Setup -> Legal: subscription-terms summary (on/off, published version, athlete counts) with the way into the
 * management screen (switch, draft, preview, publish, history). Manager-only on the server.
 */
export function SubscriptionTermsSettingsCard() {
  const { t, isRTL } = useI18n();
  const [admin, setAdmin] = useState<SubscriptionTermsAdmin | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      rpcGetSubscriptionTermsAdmin(supabase)
        .then((res) => {
          if (!cancelled) setAdmin(res.ok ? res : null);
        })
        .catch(() => {
          if (!cancelled) setAdmin(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [])
  );

  if (loading) return <Skeleton height={120} style={styles.skeleton} />;
  if (!admin) return null;
  const current = admin.versions.find((v) => v.is_current);
  const c = admin.counts;

  return (
    <View style={styles.card}>
      <AppText variant="title" isRTL={isRTL} style={styles.title}>
        {t("managerSubscriptionTerms.title")}
      </AppText>
      <AppText variant="body" isRTL={isRTL} style={styles.status}>
        {t(admin.enforced ? "managerSubscriptionTerms.statusOn" : "managerSubscriptionTerms.statusOff")}
      </AppText>
      {current ? (
        <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
          {t("managerSubscriptionTerms.version").replace("{v}", String(current.version))}
          {admin.draft ? ` · ${t("subscriptionTermsAdmin.draftPending")}` : ""}
        </AppText>
      ) : null}
      <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
        {t("managerSubscriptionTerms.counts")
          .replace("{accepted}", String(c.accepted ?? 0))
          .replace("{pending}", String(c.pending ?? 0))
          .replace("{notRequired}", String(c.not_required ?? 0))}
      </AppText>
      <PrimaryButton
        variant="ghost"
        label={t("subscriptionTermsAdmin.manage")}
        onPress={() => router.push("/(app)/manager/subscription-terms" as never)}
        style={styles.button}
      />
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
  status: { marginBottom: theme.spacing.xs, lineHeight: 21 },
  meta: { marginTop: 2, lineHeight: 18 },
  button: { marginTop: theme.spacing.md },
});
