import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { DatePickerField } from "./DatePickerField";
import { PrimaryButton } from "./PrimaryButton";
import { supabase } from "../lib/supabase";
import { toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import {
  coerceSessionPaymentMethodKey,
  paymentMethodHistoryLabel,
  SESSION_PAYMENT_METHOD_KEYS,
  type SessionPaymentMethodKey,
} from "../lib/paymentMethod";

/**
 * "Discount" is an account-payment-only method (reports/account-payments screens), not a
 * real payment — recording one reduces what's owed exactly like a real payment does,
 * without money actually changing hands. Deliberately kept out of
 * SESSION_PAYMENT_METHOD_KEYS so it never shows up in the per-session amount editor.
 */
const ACCOUNT_PAYMENT_METHOD_KEYS = [...SESSION_PAYMENT_METHOD_KEYS, "discount"] as const;
export type AccountPaymentMethodKey = SessionPaymentMethodKey | "discount";

export type AccountPaymentEdit = {
  id: string;
  amount_ils: number | string;
  payment_method: string;
  note: string | null;
  payer_name?: string | null;
  paid_at: string;
  payee_id?: string;
  payee_is_manual?: boolean;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  payeeId: string;
  payeeIsManual: boolean;
  /** Shown under the modal title (e.g. athlete name). */
  payeeLabel?: string;
  /** When set, the modal edits an existing account payment instead of creating one. */
  editPayment?: AccountPaymentEdit | null;
  /** Family billing: optional field for who physically paid. */
  showPayerName?: boolean;
  /** New (non-edit) payments only — preselects the method chip, e.g. "discount" when opened from an "Add discount" shortcut. */
  initialMethod?: AccountPaymentMethodKey;
  onSaved: () => void | Promise<void>;
};

export function AddAccountPaymentModal({
  visible,
  onClose,
  payeeId,
  payeeIsManual,
  payeeLabel,
  editPayment,
  showPayerName = false,
  initialMethod = "cash",
  onSaved,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const isEdit = !!editPayment?.id;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<AccountPaymentMethodKey>("cash");
  const [note, setNote] = useState("");
  const [payerName, setPayerName] = useState("");
  const [paidAt, setPaidAt] = useState(() => toISODateLocal(new Date()));
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (editPayment) {
      const rawAmt = editPayment.amount_ils;
      setAmount(rawAmt !== null && rawAmt !== undefined ? String(rawAmt) : "");
      const rawMethod = (editPayment.payment_method ?? "").trim().toLowerCase();
      setMethod(rawMethod === "discount" ? "discount" : coerceSessionPaymentMethodKey(editPayment.payment_method, "other"));
      setNote((editPayment.note ?? "").trim());
      setPayerName((editPayment.payer_name ?? "").trim());
      setPaidAt(editPayment.paid_at.trim());
    } else {
      setAmount("");
      setNote("");
      setPayerName("");
      setMethod(initialMethod);
      setPaidAt(toISODateLocal(new Date()));
    }
    setBusy(false);
  }, [visible, payeeId, editPayment?.id, initialMethod]);

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  async function save() {
    const amt = Number.parseFloat(amount.replace(",", ".").trim());
    if (!Number.isFinite(amt) || amt <= 0) {
      showError(language === "he" ? "הזינו סכום תקין." : "Enter a valid amount.");
      return;
    }
    if (!payeeId.trim()) {
      showError(t("common.error"));
      return;
    }
    setBusy(true);
    const payload: {
      amount_ils: number;
      payment_method: string;
      note: string | null;
      paid_at: string;
      payer_name?: string | null;
    } = {
      amount_ils: amt,
      payment_method: method,
      note: note.trim() || null,
      paid_at: paidAt.trim(),
    };
    if (showPayerName) {
      payload.payer_name = payerName.trim() || null;
    }
    const { error } = isEdit
      ? await supabase.from("athlete_account_payments").update(payload).eq("id", editPayment!.id)
      : await supabase.from("athlete_account_payments").insert({
          payee_id: payeeId,
          payee_is_manual: payeeIsManual,
          ...payload,
        });
    setBusy(false);
    if (error) {
      const msg =
        error.message.includes("account_disabled_payee")
          ? t("profile.accountDisabledPaymentHint")
          : error.message;
      showError(msg);
      return;
    }
    setSuccess(true);
    await new Promise((resolve) => setTimeout(resolve, theme.motion.normal));
    setSuccess(false);
    onClose();
    showToast({
      message: isEdit ? t("billing.paymentUpdated") : t("billing.paymentSaved"),
      variant: "success",
    });
    await onSaved();
  }

  return (
    <AppModal
      visible={visible}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      variant="dialog"
      backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
      cardStyle={styles.card}
    >
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <View style={styles.headerText}>
          <Text style={[styles.title, isRTL && styles.rtlText]}>
            {isEdit ? t("billing.editPaymentTitle") : t("billing.addPaymentTitle")}
          </Text>
          {payeeLabel?.trim() ? (
            <Text style={[styles.subtitle, isRTL && styles.rtlText]} numberOfLines={2}>
              {payeeLabel.trim()}
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

      <ScrollView
        style={styles.bodyScroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        <DatePickerField label={t("billing.paidOn")} value={paidAt} onChange={setPaidAt} />
        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.amount")}</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />
        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.method")}</Text>
        <View style={[styles.methodRow, isRTL && styles.methodRowRtl]}>
          {ACCOUNT_PAYMENT_METHOD_KEYS.map((m) => {
            const on = method === m;
            const isDiscount = m === "discount";
            return (
              <Pressable
                key={m}
                onPress={() => setMethod(m)}
                disabled={busy}
                style={({ pressed }) => [
                  styles.methodChip,
                  on && (isDiscount ? styles.methodChipDiscountOn : styles.methodChipOn),
                  pressed && !on && { opacity: 0.9 },
                ]}
              >
                <Text
                  style={[
                    styles.methodChipTxt,
                    on && (isDiscount ? styles.methodChipTxtDiscountOn : styles.methodChipTxtOn),
                  ]}
                >
                  {paymentMethodHistoryLabel(m, language)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {method === "discount" ? (
          <Text style={[styles.discountHint, isRTL && styles.rtlText]}>{t("billing.discountHint")}</Text>
        ) : null}
        {showPayerName ? (
          <>
            <Text style={[styles.label, isRTL && styles.rtlText]}>{t("families.payerNameLabel")}</Text>
            <TextInput
              value={payerName}
              onChangeText={setPayerName}
              placeholder={t("families.payerNamePlaceholder")}
              placeholderTextColor={theme.colors.placeholderOnLight}
              style={[styles.input, isRTL && styles.inputRtl]}
              editable={!busy}
            />
          </>
        ) : null}
        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.noteOptional")}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="…"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />
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
  subtitle: { marginTop: 4, fontSize: 14, fontWeight: "600", color: theme.colors.textMuted },
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
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  inputRtl: { textAlign: "right" },
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
  methodChipDiscountOn: { backgroundColor: theme.colors.warningBg, borderColor: theme.colors.warning },
  methodChipTxtDiscountOn: { color: theme.colors.warning },
  discountHint: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.warning,
    marginTop: -2,
  },
});
