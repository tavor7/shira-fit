import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { SESSION_PAYMENT_METHOD_KEYS, paymentMethodHistoryLabel, type SessionPaymentMethodKey } from "../lib/paymentMethod";
import { rowFlipFor } from "../lib/layoutDirection";
import { generateClientRequestId, rpcRecordSubscriptionPayment } from "../lib/subscriptions";
import { displayMoney } from "../lib/displayFormat";

type Props = {
  visible: boolean;
  onClose: () => void;
  subscriptionId: string;
  /** Shown under the modal title (e.g. athlete name). */
  payeeLabel?: string;
  /** Pre-fills the amount field (the subscription's monthly price) -- the manager can change it. */
  defaultAmountIls: number;
  /** Pre-formatted lifetime balance for this subscription ("Owes X" / "Credit X"), shown as context only -- never allocated to a specific period. Omit (null/undefined) when there's nothing to show (e.g. balance is exactly even). */
  outstandingLabel?: string | null;
  onSaved: () => void | Promise<void>;
};

/**
 * Records an additional payment against an existing subscription (3.2). Reuses the existing
 * athlete_account_payments ledger via the manager-only record_subscription_payment RPC -- never a
 * direct table insert, since authorization and the subscription-id link must be enforced
 * server-side. No receipt is issued here; that stays a separate, manual step.
 */
export function AddSubscriptionPaymentModal({
  visible,
  onClose,
  subscriptionId,
  payeeLabel,
  defaultAmountIls,
  outstandingLabel,
  onSaved,
}: Props) {
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<SessionPaymentMethodKey>("cash");
  const [payerName, setPayerName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  // Stable for the lifetime of one submit attempt, including its retries -- regenerated only when
  // the modal is freshly opened, so a duplicate-tap retry converges on the same payment server-side
  // instead of creating a second one.
  const clientRequestIdRef = useRef(generateClientRequestId());

  useEffect(() => {
    if (!visible) return;
    setAmount(defaultAmountIls > 0 ? String(defaultAmountIls) : "");
    setMethod("cash");
    setPayerName("");
    setNote("");
    setBusy(false);
    clientRequestIdRef.current = generateClientRequestId();
  }, [visible, subscriptionId, defaultAmountIls]);

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  async function save() {
    if (busy) return; // duplicate-submit protection (pointer-level, before the idempotency token even matters)
    const amt = Number.parseFloat(amount.replace(",", ".").trim());
    if (!Number.isFinite(amt) || amt <= 0) {
      showError(t("ui.addAccountPayment.enterAValidAmount"));
      return;
    }
    setBusy(true);
    try {
      const res = await rpcRecordSubscriptionPayment(supabase, subscriptionId, {
        amountIls: amt,
        paymentMethod: method,
        payerName: payerName.trim() || null,
        note: note.trim() || null,
        clientRequestId: clientRequestIdRef.current,
      });
      if (!res.ok) {
        showError(res.error === "subscription_not_found" ? t("subscriptions.detail.loadError") : t("subscriptions.genericError"));
        setBusy(false);
        return;
      }
      setSuccess(true);
      await new Promise((resolve) => setTimeout(resolve, theme.motion.normal));
      setSuccess(false);
      onClose();
      showToast({ message: t("subscriptions.payment.saved"), variant: "success" });
      await onSaved();
    } catch (e) {
      showError(e instanceof Error ? e.message : t("subscriptions.genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppModal
      visible={visible}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      variant="dialog"
      backdropAccessibilityLabel={t("ui.addAccountPayment.dismiss")}
      cardStyle={styles.card}
    >
      <View style={[styles.header, rowFlipFor(isRTL) && styles.headerRtl]}>
        <View style={styles.headerText}>
          <Text style={[styles.title, isRTL && styles.rtlText]}>{t("subscriptions.payment.title")}</Text>
          {payeeLabel?.trim() ? (
            <Text style={[styles.subtitle, isRTL && styles.rtlText]} numberOfLines={2}>
              {payeeLabel.trim()}
            </Text>
          ) : null}
          {outstandingLabel ? (
            <Text style={[styles.subtitle, isRTL && styles.rtlText]}>
              {t("subscriptions.payment.outstandingHint").replace("{balance}", outstandingLabel)}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            if (busy) return;
            onClose();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t("common.cancel")}
        >
          <Text style={styles.close}>{t("common.cancel")}</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.amount")}</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={theme.colors.fieldPlaceholder}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />
        {defaultAmountIls > 0 ? (
          <Text style={[styles.hint, isRTL && styles.rtlText]}>
            {t("subscriptions.payment.monthlyPriceHint").replace("{price}", displayMoney(defaultAmountIls))}
          </Text>
        ) : null}

        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.method")}</Text>
        <View style={[styles.methodRow, rowFlipFor(isRTL) && styles.methodRowRtl]}>
          {SESSION_PAYMENT_METHOD_KEYS.map((m) => {
            const on = method === m;
            return (
              <Pressable
                key={m}
                onPress={() => setMethod(m)}
                disabled={busy}
                style={({ pressed }) => [styles.methodChip, on && styles.methodChipOn, pressed && !on && { opacity: 0.9 }]}
              >
                <Text style={[styles.methodChipTxt, on && styles.methodChipTxtOn]}>{paymentMethodHistoryLabel(m, language)}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("families.payerNameLabel")}</Text>
        <TextInput
          value={payerName}
          onChangeText={setPayerName}
          placeholder={t("families.payerNamePlaceholder")}
          placeholderTextColor={theme.colors.fieldPlaceholder}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />

        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.noteOptional")}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="…"
          placeholderTextColor={theme.colors.fieldPlaceholder}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />

        <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("subscriptions.payment.noReceiptHint")}</Text>

        <PrimaryButton
          label={t("common.save")}
          loading={busy && !success}
          success={success}
          loadingLabel={t("common.loading")}
          onPress={() => void save()}
        />
      </ScrollView>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { maxWidth: 440, width: "100%" },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: "800", color: theme.colors.text },
  subtitle: { marginTop: 4, ...theme.typography.secondary, color: theme.colors.textMuted },
  close: { fontSize: 15, fontWeight: "800", color: theme.colors.textMuted },
  rtlText: { textAlign: "right", writingDirection: "rtl" },
  bodyScroll: { flexShrink: 1 },
  body: { padding: theme.spacing.md, gap: 8, paddingBottom: theme.spacing.lg },
  label: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    fontSize: 16,
    backgroundColor: theme.colors.fieldBg,
    color: theme.colors.fieldText,
  },
  inputRtl: { textAlign: "right" },
  hint: { fontSize: 12, lineHeight: 16, color: theme.colors.textMuted, marginTop: -2 },
  methodRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  methodRowRtl: { flexDirection: "row-reverse" },
  methodChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  methodChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  methodChipTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  methodChipTxtOn: { color: theme.colors.ctaText },
});
