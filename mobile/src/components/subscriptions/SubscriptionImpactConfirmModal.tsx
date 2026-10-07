import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { tierLabelKey, type SubscriptionImpact } from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";

export type ImpactConfirmAction = "edit" | "freeze" | "stop";

type Props = {
  visible: boolean;
  action: ImpactConfirmAction;
  impact: SubscriptionImpact | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Single shared impact-preview/confirm dialog, reused for edit/freeze/stop — one source of truth
 * in the frontend for the identical conceptual moment (some currently-covered registrations would
 * flip to paid-extra). Never computes the impact itself: `impact` always comes straight from the
 * backend's subscription_compute_impact (via edit_subscription_version / freeze_subscription /
 * stop_subscription's own preview response) and confirming re-calls the SAME RPC with
 * p_confirmed=true, so the server always re-verifies before applying — this dialog only presents
 * what the server already decided.
 */
export function SubscriptionImpactConfirmModal({ visible, action, impact, busy, onCancel, onConfirm }: Props) {
  const { t, language, isRTL } = useI18n();

  const titleKey =
    action === "edit" ? "subscriptions.impact.titleEdit" : action === "freeze" ? "subscriptions.impact.titleFreeze" : "subscriptions.impact.titleStop";

  const count = impact?.count ?? 0;
  const items = impact?.items ?? [];
  const shown = items.slice(0, 8);
  const remaining = items.length - shown.length;

  return (
    <AppModal visible={visible} onClose={onCancel} variant="dialog" backdropAccessibilityLabel={t("subscriptions.impact.cancel")}>
      <View style={styles.card}>
        <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
          {t(titleKey)}
        </Text>
        <Text style={[styles.message, isRTL && styles.rtl]}>
          {t("subscriptions.impact.message").replace("{n}", String(count))}
        </Text>

        {shown.length > 0 ? (
          <View style={styles.detailBox}>
            <Text style={[styles.detailHeader, isRTL && styles.rtl]}>{t("subscriptions.impact.detailHeader")}</Text>
            <ScrollView style={styles.detailList} keyboardShouldPersistTaps="handled">
              {shown.map((item, idx) => (
                <View key={`${item.registration_id ?? item.manual_participant_id ?? idx}`} style={[styles.detailRow, rowFlipFor(isRTL) && styles.detailRowRtl]}>
                  <Text style={[styles.detailDate, isRTL && styles.rtl]}>{formatISODateFull(item.session_date, language)}</Text>
                  <Text style={[styles.detailTier, isRTL && styles.rtl]}>{t(tierLabelKey(item.tier))}</Text>
                </View>
              ))}
              {remaining > 0 ? (
                <Text style={[styles.moreLine, isRTL && styles.rtl]}>
                  {t("subscriptions.impact.moreItems").replace("{n}", String(remaining))}
                </Text>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        <View style={[styles.actions, rowFlipFor(isRTL) && styles.actionsRtl]}>
          <PrimaryButton label={t("subscriptions.impact.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          <PrimaryButton
            label={t("subscriptions.impact.confirm")}
            onPress={onConfirm}
            loading={busy}
            variant="danger"
            style={styles.btn}
          />
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { padding: theme.spacing.lg },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: theme.spacing.sm },
  message: { fontSize: 15, fontWeight: "500", lineHeight: 22, color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  detailBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  detailHeader: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", marginBottom: 6 },
  detailList: { maxHeight: 160 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, gap: 8 },
  detailRowRtl: { flexDirection: "row-reverse" },
  detailDate: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  detailTier: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
  moreLine: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginTop: 4 },
  actions: { flexDirection: "row", gap: theme.spacing.sm, justifyContent: "flex-end" },
  actionsRtl: { flexDirection: "row-reverse" },
  btn: { flexGrow: 1, flexShrink: 1, minWidth: 120 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
