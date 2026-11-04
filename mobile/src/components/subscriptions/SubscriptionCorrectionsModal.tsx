import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { displayMoney } from "../../lib/displayFormat";
import { rowFlipFor } from "../../lib/layoutDirection";
import {
  rpcListSubscriptionCorrections,
  rpcResolveSubscriptionCorrection,
  type SubscriptionCorrection,
} from "../../lib/subscriptions";

type Props = { visible: boolean; onClose: () => void; onChanged: () => void };

/**
 * Receipt-locked sessions left by a deleted subscription. Each waits for the manager's decision; neither choice touches a
 * receipt or a payment. Until the accounting treatment is confirmed, asking for the regular price only sends the session to
 * accounting review and changes no amount.
 */
export function SubscriptionCorrectionsModal({ visible, onClose, onChanged }: Props) {
  const { t, language, isRTL } = useI18n();
  const { showToast } = useToast();
  const flip = rowFlipFor(isRTL);
  const [items, setItems] = useState<SubscriptionCorrection[] | null>(null);
  const [accountingConfirmed, setAccountingConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await rpcListSubscriptionCorrections(supabase);
      if (res.ok) {
        setItems(res.corrections);
        setAccountingConfirmed(res.accounting_confirmed);
      } else {
        setItems(null);
        setFailed(true);
      }
    } catch {
      setItems(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setItems(null);
    setOpenId(null);
    setReason("");
    void load();
  }, [visible, load]);

  async function decide(item: SubscriptionCorrection, decision: "applied_regular_price" | "kept_covered") {
    setBusy(true);
    try {
      const res = await rpcResolveSubscriptionCorrection(supabase, item.id, decision, reason.trim(), item.regular_price_ils);
      if (!res.ok) {
        showToast({
          message: t(res.error === "correction_changed" ? "subscriptions.corrections.changed" : "subscriptions.genericError"),
          detail: res.error === "correction_changed" ? undefined : res.error,
          variant: "error",
        });
        await load();
        return;
      }
      showToast({
        message: t(res.action === "awaiting_accounting" ? "subscriptions.corrections.awaitingSaved" : "subscriptions.corrections.saved"),
        variant: "success",
      });
      setOpenId(null);
      setReason("");
      await load();
      onChanged();
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppModal visible={visible} onClose={onClose} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("common.close")}>
      <View style={styles.card}>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
            {t("subscriptions.corrections.title")}
          </Text>
          <Text style={[styles.message, isRTL && styles.rtl]}>{t("subscriptions.corrections.explain")}</Text>
          {failed ? (
            <Text style={[styles.message, isRTL && styles.rtl]} accessibilityRole="alert">
              {t("subscriptions.overview.loadError")}
            </Text>
          ) : items === null ? (
            <ActivityIndicator color={theme.colors.textMuted} />
          ) : items.length === 0 ? (
            <Text style={[styles.message, isRTL && styles.rtl]}>{t("subscriptions.corrections.none")}</Text>
          ) : (
            items.map((item) => {
              const awaiting = item.status === "awaiting_accounting";
              return (
              <View key={item.id} style={styles.item}>
                <Text style={[styles.name, isRTL && styles.rtl]}>{item.payee_display_name}</Text>
                {awaiting ? (
                  <View style={[styles.chip, isRTL && styles.chipRtl]}>
                    <Text style={styles.chipText}>{t("subscriptions.corrections.awaitingChip")}</Text>
                  </View>
                ) : null}
                <Text style={[styles.line, isRTL && styles.rtl]}>
                  {formatISODateFull(item.session_date, language)} · {t(`subscriptions.deleteImpact.state.${item.slot_state}`)}
                </Text>
                <View style={[styles.row, flip && styles.rowRtl]}>
                  <Text style={[styles.line, isRTL && styles.rtl]}>{t("subscriptions.corrections.regularPrice")}</Text>
                  <Text style={styles.value}>{displayMoney(item.regular_price_ils)}</Text>
                </View>
                <View style={[styles.row, flip && styles.rowRtl]}>
                  <Text style={[styles.line, isRTL && styles.rtl]}>{t("subscriptions.corrections.paid")}</Text>
                  <Text style={styles.value}>{displayMoney(item.amount_paid_ils)}</Text>
                </View>
                <View style={[styles.row, flip && styles.rowRtl]}>
                  <Text style={[styles.line, isRTL && styles.rtl]}>{t("subscriptions.corrections.receipts")}</Text>
                  <Text style={styles.value}>
                    {item.receipts.map((r) => (r.number != null ? `#${r.number}` : t("subscriptions.corrections.externalReceipt"))).join(", ")}
                  </Text>
                </View>
                {awaiting && item.review_requested_at ? (
                  <Text style={[styles.line, isRTL && styles.rtl]}>
                    {t("subscriptions.corrections.awaitingExplain")
                      .replace("{date}", formatISODateFull(item.review_requested_at.slice(0, 10), language))
                      .replace("{reason}", item.review_reason ?? "")}
                  </Text>
                ) : null}
                {openId === item.id ? (
                  <View style={styles.decide}>
                    <Text style={[styles.line, isRTL && styles.rtl]}>
                      {t(accountingConfirmed ? "subscriptions.corrections.applyEffect" : "subscriptions.corrections.requestEffect").replace("{amount}", displayMoney(item.balance_change_if_applied_ils))}
                    </Text>
                    <TextInput
                      value={reason}
                      onChangeText={setReason}
                      placeholder={t("billing.reversePaymentReason")}
                      placeholderTextColor={theme.colors.textSoft}
                      accessibilityLabel={t("billing.reversePaymentReason")}
                      style={[styles.input, isRTL && styles.rtl]}
                    />
                    <View style={[styles.actions, flip && styles.rowRtl]}>
                      <PrimaryButton
                        label={t("subscriptions.corrections.keep")}
                        onPress={() => void decide(item, "kept_covered")}
                        disabled={reason.trim().length < 3 || busy}
                        variant="ghost"
                        style={styles.btn}
                      />
                      {accountingConfirmed || !awaiting ? (
                        <PrimaryButton
                          label={t(accountingConfirmed ? "subscriptions.corrections.apply" : "subscriptions.corrections.request")}
                          onPress={() => void decide(item, "applied_regular_price")}
                          disabled={reason.trim().length < 3}
                          loading={busy}
                          variant={accountingConfirmed ? "danger" : undefined}
                          style={styles.btn}
                        />
                      ) : null}
                    </View>
                  </View>
                ) : (
                  <PrimaryButton
                    label={t("subscriptions.corrections.review")}
                    onPress={() => {
                      setOpenId(item.id);
                      setReason("");
                    }}
                    variant="ghost"
                  />
                )}
              </View>
              );
            })
          )}
        </ScrollView>
        <PrimaryButton label={t("common.close")} onPress={onClose} variant="ghost" />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.spacing.md, gap: theme.spacing.sm, maxHeight: "100%" },
  body: { flexShrink: 1 },
  bodyContent: { gap: theme.spacing.sm },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  message: { fontSize: 14, lineHeight: 20, color: theme.colors.textMuted },
  item: { gap: 6, padding: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceElevated },
  name: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  line: { fontSize: 13, color: theme.colors.textMuted, flexShrink: 1 },
  value: { fontSize: 13, fontWeight: "800", color: theme.colors.text, flexShrink: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  chip: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border },
  chipRtl: { alignSelf: "flex-end" },
  chipText: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  decide: { gap: 8 },
  input: { minHeight: 44, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderInput, backgroundColor: theme.colors.surface, color: theme.colors.text, fontSize: 16 },
  actions: { flexDirection: "row", gap: theme.spacing.sm },
  btn: { flex: 1 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
