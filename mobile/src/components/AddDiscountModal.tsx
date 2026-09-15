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

type Props = {
  visible: boolean;
  onClose: () => void;
  payeeId: string;
  payeeIsManual: boolean;
  /** Shown under the modal title (e.g. athlete name). */
  payeeLabel?: string;
  onSaved: () => void | Promise<void>;
};

/**
 * Separate from AddAccountPaymentModal on purpose: a discount isn't a real payment (no
 * money changes hands, no payment method to pick) — it reduces what's owed, same math as
 * a real payment, but shouldn't be mixed into the same "pick a method" flow. Existing
 * discount entries are still editable through AddAccountPaymentModal's own edit path.
 */
export function AddDiscountModal({ visible, onClose, payeeId, payeeIsManual, payeeLabel, onSaved }: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paidAt, setPaidAt] = useState(() => toISODateLocal(new Date()));
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setAmount("");
    setNote("");
    setPaidAt(toISODateLocal(new Date()));
    setBusy(false);
  }, [visible, payeeId]);

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
    const { error } = await supabase.from("athlete_account_payments").insert({
      payee_id: payeeId,
      payee_is_manual: payeeIsManual,
      amount_ils: amt,
      payment_method: "discount",
      note: note.trim() || null,
      paid_at: paidAt.trim(),
    });
    setBusy(false);
    if (error) {
      const msg =
        error.message.includes("account_disabled_payee") ? t("profile.accountDisabledPaymentHint") : error.message;
      showError(msg);
      return;
    }
    setSuccess(true);
    await new Promise((resolve) => setTimeout(resolve, theme.motion.normal));
    setSuccess(false);
    onClose();
    showToast({ message: t("billing.discountSaved"), variant: "success" });
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
          <Text style={[styles.title, isRTL && styles.rtlText]}>{t("billing.addDiscountTitle")}</Text>
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

      <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.discountHint, isRTL && styles.rtlText]}>{t("billing.discountHint")}</Text>

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
          label={t("billing.addDiscount")}
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
  discountHint: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.warning,
    backgroundColor: theme.colors.warningBg,
    borderWidth: 1,
    borderColor: theme.colors.warning,
    borderRadius: theme.radius.md,
    padding: 8,
  },
});
