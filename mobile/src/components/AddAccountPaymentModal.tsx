import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { DatePickerField } from "./DatePickerField";
import { PrimaryButton } from "./PrimaryButton";
import { supabase } from "../lib/supabase";
import { toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { paymentMethodHistoryLabel } from "../lib/paymentMethod";

type Props = {
  visible: boolean;
  onClose: () => void;
  payeeId: string;
  payeeIsManual: boolean;
  /** Shown under the modal title (e.g. athlete name). */
  payeeLabel?: string;
  onSaved: () => void | Promise<void>;
};

export function AddAccountPaymentModal({
  visible,
  onClose,
  payeeId,
  payeeIsManual,
  payeeLabel,
  onSaved,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "paybox" | "other">("cash");
  const [note, setNote] = useState("");
  const [paidAt, setPaidAt] = useState(() => toISODateLocal(new Date()));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setAmount("");
    setNote("");
    setMethod("cash");
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
      payment_method: method,
      note: note.trim() || null,
      paid_at: paidAt.trim(),
    });
    setBusy(false);
    if (error) {
      showError(error.message);
      return;
    }
    onClose();
    showToast({ message: t("billing.paymentSaved"), variant: "success" });
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
          <Text style={[styles.title, isRTL && styles.rtlText]}>{t("billing.addPaymentTitle")}</Text>
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

      <View style={styles.body}>
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
          {(["cash", "paybox", "other"] as const).map((m) => {
            const on = method === m;
            return (
              <Pressable
                key={m}
                onPress={() => setMethod(m)}
                disabled={busy}
                style={({ pressed }) => [
                  styles.methodChip,
                  on && styles.methodChipOn,
                  pressed && !on && { opacity: 0.9 },
                ]}
              >
                <Text style={[styles.methodChipTxt, on && styles.methodChipTxtOn]}>
                  {paymentMethodHistoryLabel(m, language)}
                </Text>
              </Pressable>
            );
          })}
        </View>
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
          loading={busy}
          loadingLabel={t("common.loading")}
          onPress={() => void save()}
        />
      </View>
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
});
