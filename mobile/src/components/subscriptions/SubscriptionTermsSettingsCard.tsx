import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { supabase } from "../../lib/supabase";
import { rowFlipFor } from "../../lib/layoutDirection";
import { AppText } from "../AppText";
import { PrimaryButton } from "../PrimaryButton";
import { Skeleton } from "../Skeleton";
import { rpcGetSubscriptionTermsAdmin, type SubscriptionTermsAdmin } from "../../lib/subscriptionTerms";

/**
 * Setup -> Subscriptions: subscription-terms summary (on/off, published version, athlete counts) with the way into the
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
      <View style={[styles.head, rowFlipFor(isRTL) && styles.headRtl]}>
        <AppText variant="title" isRTL={isRTL} style={styles.title}>
          {t("managerSubscriptionTerms.title")}
        </AppText>
        <View style={[styles.badge, admin.enforced ? styles.badgeOn : styles.badgeOff]}>
          <AppText variant="caption" style={[styles.badgeTxt, admin.enforced ? styles.badgeTxtOn : null]}>
            {t(admin.enforced ? "managerSubscriptionTerms.badgeOn" : "managerSubscriptionTerms.badgeOff")}
          </AppText>
        </View>
      </View>
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
  skeleton: { borderRadius: theme.radius.lg },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, marginBottom: theme.spacing.xs },
  headRtl: { flexDirection: "row-reverse" },
  title: { flex: 1 },
  badge: { borderRadius: theme.radius.full, paddingHorizontal: 10, paddingVertical: 3 },
  badgeOn: { backgroundColor: theme.colors.successBg },
  badgeOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeTxt: { fontWeight: "800", color: theme.colors.textMuted },
  badgeTxtOn: { color: theme.colors.success },
  meta: { marginTop: 2, lineHeight: 18 },
  button: { marginTop: theme.spacing.md },
});
