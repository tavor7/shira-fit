import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { displayMoney } from "../../lib/displayFormat";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import type { UnfreezeOutcome } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  preview: UnfreezeOutcome | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** What the server calculated this unfreeze would do. A future, a running and a finished freeze read differently. */
export function UnfreezeSubscriptionModal({ visible, preview, busy, onCancel, onConfirm }: Props) {
  const { t, language, isRTL } = useI18n();
  const flip = rowFlipFor(isRTL);
  if (!preview || !preview.kind) return null;
  const date = (iso?: string | null) => (iso ? formatISODateFull(iso, language) : t("subscriptions.unfreeze.noDate"));
  const changes = preview.session_changes ?? [];
  const gained = changes.filter((c) => c.covered_after && !c.covered_before).length;
  const lost = changes.filter((c) => !c.covered_after && c.covered_before).length;

  return (
    <AppModal visible={visible} onClose={onCancel} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("common.cancel")}>
      <View style={styles.card}>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
            {t(`subscriptions.unfreeze.title.${preview.kind}`)}
          </Text>
          <Text style={[styles.message, isRTL && styles.rtl]}>
            {t(`subscriptions.unfreeze.body.${preview.kind}`).replace("{from}", date(preview.freeze_from)).replace("{until}", date(preview.freeze_until))}
          </Text>
          <Line label={t("subscriptions.unfreeze.nextCharge")} value={`${date(preview.next_billing_before)} ${isRTL ? "←" : "→"} ${date(preview.next_billing_after)}`} flip={flip} isRTL={isRTL} />
          {preview.plan_end_before ? (
            <Line label={t("subscriptions.unfreeze.planEnd")} value={`${date(preview.plan_end_before)} ${isRTL ? "←" : "→"} ${date(preview.plan_end_after)}`} flip={flip} isRTL={isRTL} />
          ) : null}
          <Line label={t("subscriptions.unfreeze.sessionsGained")} value={String(gained)} flip={flip} isRTL={isRTL} />
          {lost > 0 ? <Line label={t("subscriptions.unfreeze.sessionsLost")} value={String(lost)} flip={flip} isRTL={isRTL} /> : null}
          {preview.charges_change_ils ? (
            <Line label={t("subscriptions.unfreeze.chargesChange")} value={displayMoney(preview.charges_change_ils)} flip={flip} isRTL={isRTL} />
          ) : null}
          {preview.sessions_kept_at_paid_regular_price ? (
            <Text style={[styles.alert, isRTL && styles.rtl]}>
              {pluralKey(t, "subscriptions.unfreeze.keptPaid", preview.sessions_kept_at_paid_regular_price).replace("{n}", String(preview.sessions_kept_at_paid_regular_price))}
            </Text>
          ) : null}
          {preview.next_charge_becomes_due ? (
            <Text style={[styles.alert, isRTL && styles.rtl]}>{t("subscriptions.unfreeze.chargeDue")}</Text>
          ) : null}
        </ScrollView>
        <View style={[styles.actions, flip && styles.rowRtl]}>
          <PrimaryButton label={t("common.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          <PrimaryButton label={t("subscriptions.unfreeze.confirm")} onPress={onConfirm} loading={busy} style={styles.btn} />
        </View>
      </View>
    </AppModal>
  );
}

function Line({ label, value, flip, isRTL }: { label: string; value: string; flip: boolean; isRTL: boolean }) {
  return (
    <View style={[styles.row, flip && styles.rowRtl]}>
      <Text style={[styles.rowLabel, isRTL && styles.rtl]}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.spacing.md, gap: theme.spacing.sm, maxHeight: "100%" },
  body: { flexShrink: 1 },
  bodyContent: { gap: theme.spacing.sm },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  message: { fontSize: 14, lineHeight: 20, color: theme.colors.textMuted },
  alert: { fontSize: 13, lineHeight: 19, color: theme.colors.alertSubject, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceElevated },
  row: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  rowLabel: { fontSize: 13, color: theme.colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text, flexShrink: 1 },
  actions: { flexDirection: "row", gap: theme.spacing.sm },
  btn: { flex: 1 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
