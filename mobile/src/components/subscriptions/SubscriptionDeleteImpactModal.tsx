import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { displayMoney } from "../../lib/displayFormat";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import type { SubscriptionDeleteImpact } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  impact: SubscriptionDeleteImpact | null;
  busy?: boolean;
  notice?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Everything a delete would change, read from the server before the manager decides. Confirming is tied to this exact list:
 * if it changes in the meantime, the server refuses and the new list is shown here instead.
 */
export function SubscriptionDeleteImpactModal({ visible, impact, busy, notice, onCancel, onConfirm }: Props) {
  const { t, language, isRTL } = useI18n();
  const flip = rowFlipFor(isRTL);
  if (!impact) return null;
  const blocked = impact.blocking_payments_count > 0;
  const repriced = impact.history_sessions.filter((s) => !s.has_receipt);
  const locked = impact.history_sessions.filter((s) => s.has_receipt);

  return (
    <AppModal visible={visible} onClose={onCancel} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("common.cancel")}>
      <View style={styles.card}>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
            {t("subscriptions.delete.title")}
          </Text>
          {notice ? (
            <Text style={[styles.alert, isRTL && styles.rtl]} accessibilityRole="alert">
              {notice}
            </Text>
          ) : null}

          {blocked ? (
            <Text style={[styles.alert, isRTL && styles.rtl]} accessibilityRole="alert">
              {pluralKey(t, "subscriptions.deleteImpact.blocked", impact.blocking_payments_count)
                .replace("{n}", String(impact.blocking_payments_count))
                .replace("{amount}", displayMoney(impact.blocking_payments_ils))}
            </Text>
          ) : (
            <>
              <Text style={[styles.message, isRTL && styles.rtl]}>{t("subscriptions.delete.message")}</Text>
              <Line label={t("subscriptions.deleteImpact.chargesReversed")} value={displayMoney(impact.charges_to_reverse_ils)} flip={flip} isRTL={isRTL} />
              <Line label={t("subscriptions.deleteImpact.newDebt")} value={displayMoney(impact.new_debt_ils)} flip={flip} isRTL={isRTL} />
              {impact.payee_discounts_ils > 0 ? (
                <Line label={t("subscriptions.deleteImpact.discounts")} value={displayMoney(impact.payee_discounts_ils)} flip={flip} isRTL={isRTL} />
              ) : null}
              {impact.receipt_locked_count > 0 ? (
                <Text style={[styles.alert, isRTL && styles.rtl]} accessibilityRole="alert">
                  {pluralKey(t, "subscriptions.deleteImpact.receiptLocked", impact.receipt_locked_count).replace("{n}", String(impact.receipt_locked_count))}
                </Text>
              ) : null}

              {impact.future_registrations_count > 0 ? (
                <Line label={t("subscriptions.deleteImpact.futureBookings")} value={String(impact.future_registrations_count)} flip={flip} isRTL={isRTL} />
              ) : null}

              {repriced.length > 0 ? (
                <View style={styles.list}>
                  <Text style={[styles.header, isRTL && styles.rtl]}>{t("subscriptions.deleteImpact.sessionsHeader")}</Text>
                  {repriced.map((s) => (
                    <View key={s.coverage_id} style={[styles.row, flip && styles.rowRtl]}>
                      <Text style={[styles.rowLabel, isRTL && styles.rtl]}>
                        {formatISODateFull(s.session_date, language)} · {t(`subscriptions.deleteImpact.state.${s.slot_state}`)}
                        {s.amount_paid_ils > 0 ? ` · ${t("subscriptions.deleteImpact.paid").replace("{amount}", displayMoney(s.amount_paid_ils))}` : ""}
                      </Text>
                      <Text style={styles.rowValue}>{displayMoney(s.regular_price_ils)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {locked.length > 0 ? (
                <View style={styles.list}>
                  <Text style={[styles.header, isRTL && styles.rtl]}>{t("subscriptions.deleteImpact.lockedHeader")}</Text>
                  {locked.map((s) => (
                    <View key={s.coverage_id} style={[styles.row, flip && styles.rowRtl]}>
                      <Text style={[styles.rowLabel, isRTL && styles.rtl]}>
                        {formatISODateFull(s.session_date, language)} · {t(`subscriptions.deleteImpact.state.${s.slot_state}`)}
                        {" · "}
                        {t("subscriptions.deleteImpact.paid").replace("{amount}", displayMoney(s.amount_paid_ils))}
                        {" · "}
                        {s.receipts.map((r) => (r.number != null ? `#${r.number}` : t("subscriptions.corrections.externalReceipt"))).join(", ")}
                      </Text>
                      <Text style={styles.rowValue}>{displayMoney(s.regular_price_ils)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
        <View style={[styles.actions, flip && styles.rowRtl]}>
          <PrimaryButton label={t("common.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          {!blocked ? (
            <PrimaryButton label={t("subscriptions.deleteImpact.confirm")} onPress={onConfirm} loading={busy} variant="danger" style={styles.btn} />
          ) : null}
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
  alert: { fontSize: 13, lineHeight: 19, fontWeight: "700", color: theme.colors.text, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  list: { gap: 6 },
  header: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft },
  row: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  rowLabel: { fontSize: 13, color: theme.colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  actions: { flexDirection: "row", gap: theme.spacing.sm },
  btn: { flex: 1 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
