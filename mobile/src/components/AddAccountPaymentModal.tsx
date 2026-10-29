import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { DatePickerField } from "./DatePickerField";
import { PrimaryButton } from "./PrimaryButton";
import { supabase } from "../lib/supabase";
import { toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import {
  coerceSessionPaymentMethodKey,
  paymentMethodHistoryLabel,
  SESSION_PAYMENT_METHOD_KEYS,
  type SessionPaymentMethodKey,
} from "../lib/paymentMethod";
import { rowFlipFor } from "../lib/layoutDirection";
import { generateClientRequestId, rpcRecordSubscriptionPayment } from "../lib/subscriptions";

/**
 * "Discount" is recorded through the separate AddDiscountModal, not offered as a chip
 * here — this modal is for real payments only. An existing discount payment can still be
 * opened for editing (its chip is shown, but only in that case — see methodChoices below).
 *
 * When creating a new payment for a payee with an active subscription, an explicit "this is a
 * subscription payment" toggle (off by default) is offered. Checking it routes the save through
 * record_subscription_payment (the same manager-only RPC AddSubscriptionPaymentModal uses) rather
 * than a direct table insert, so the payment is correctly tagged source_subscription_id and
 * counts toward subscription-specific totals regardless of which screen it was recorded from.
 * Unchecked (or no active subscription), behavior is unchanged: a plain account payment.
 */
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
  onSaved,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const isEdit = !!editPayment?.id;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<AccountPaymentMethodKey>("cash");
  const [note, setNote] = useState("");
  const [payerName, setPayerName] = useState("");
  const [paidAt, setPaidAt] = useState(() => toISODateLocal(new Date()));
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  // The subscription eligible to receive THIS payment (by payee and the selected paidAt date),
  // if any -- re-resolved whenever the payee or date changes, never for an edit (an existing
  // payment's subscription link is never changed here). Drives the optional "this is a
  // subscription payment" toggle below. Null while loading or when nothing is eligible, in which
  // case the toggle is never shown -- see eligibilityLoading for why "loading" and "none" are
  // kept separate.
  const [activeSubscriptionId, setActiveSubscriptionId] = useState<string | null>(null);
  // True until the eligibility query for the CURRENT payee/date has resolved. The toggle is never
  // rendered while this is true, so a stale/incorrect eligibility state from a prior payee or
  // date can never be acted on mid-flight.
  const [eligibilityLoading, setEligibilityLoading] = useState(true);
  // Explicit opt-in, defaults to off every time the modal opens -- a general account payment is
  // never auto-attached to a subscription just because one exists (see modal docstring below).
  const [isSubscriptionPayment, setIsSubscriptionPayment] = useState(false);
  const clientRequestIdRef = useRef(generateClientRequestId());

  // Subscription-payment eligibility for one payee as of one date -- exactly mirrors
  // record_subscription_payment's own server-side check (migration 20261029220000): prefer the
  // version effective on the selected date; if none covers it yet because the subscription hasn't
  // started (an advance payment against a scheduled subscription is legitimate, not "inactive"),
  // fall back to its earliest version instead. Either way, ineligible if that version is already
  // stopped or past its plan_end_date as of the date; a frozen version is still eligible -- a
  // freeze pauses billing/coverage, it does not end the relationship. The RPC is the actual
  // authority (this is a client-side replica, not the enforcement -- see that migration's
  // comment), reading subscriptions/subscription_versions directly since RLS already scopes them
  // to managers only, the same role record_subscription_payment itself requires.
  useEffect(() => {
    if (!visible || isEdit) {
      setActiveSubscriptionId(null);
      setEligibilityLoading(false);
      return;
    }
    const dateToCheck = paidAt.trim();
    if (!dateToCheck) {
      setActiveSubscriptionId(null);
      setEligibilityLoading(false);
      return;
    }
    let cancelled = false;
    setEligibilityLoading(true);
    void (async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select(
          "id, subscription_versions(id, effective_from, effective_to, stopped_effective_date, plan_end_date)"
        )
        .eq("payee_id", payeeId)
        .eq("payee_is_manual", payeeIsManual)
        .is("deleted_at", null);
      type VersionRow = {
        id: string;
        effective_from: string;
        effective_to: string | null;
        stopped_effective_date: string | null;
        plan_end_date: string | null;
      };
      type SubRow = { id: string; subscription_versions: VersionRow[] | null };
      let eligibleId: string | null = null;
      for (const sub of (data as SubRow[] | null) ?? []) {
        const all = sub.subscription_versions ?? [];
        // The version effective at dateToCheck, if any.
        const covering = all
          .filter((v) => v.effective_from <= dateToCheck && (v.effective_to === null || v.effective_to > dateToCheck))
          .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
        // Otherwise, if dateToCheck is before the subscription has even started, an advance
        // payment is still legitimate -- fall back to the earliest (not-yet-started) version so a
        // stop applied in advance still correctly blocks it. Mirrors
        // record_subscription_payment's own fallback exactly.
        const notYetStarted = all
          .filter((v) => v.effective_from > dateToCheck)
          .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
        const v = covering ?? notYetStarted;
        if (!v) continue;
        if (v.stopped_effective_date !== null && dateToCheck >= v.stopped_effective_date) continue;
        if (v.plan_end_date !== null && dateToCheck > v.plan_end_date) continue;
        eligibleId = sub.id;
        break;
      }
      if (cancelled) return;
      setActiveSubscriptionId(eligibleId);
      setEligibilityLoading(false);
      // The athlete/date changed and the previously-eligible subscription no longer is (or never
      // was) -- never leave a stale opt-in checked against an invalid selection.
      if (!eligibleId) setIsSubscriptionPayment(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, isEdit, payeeId, payeeIsManual, paidAt]);

  useEffect(() => {
    if (!visible) return;
    setIsSubscriptionPayment(false);
    clientRequestIdRef.current = generateClientRequestId();
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
      setMethod("cash");
      setPaidAt(toISODateLocal(new Date()));
    }
    setBusy(false);
  }, [visible, payeeId, editPayment?.id]);

  // Only offer the "discount" chip when editing a payment that's already a discount —
  // never for a brand-new entry (use AddDiscountModal for that).
  const methodChoices: readonly AccountPaymentMethodKey[] =
    isEdit && method === "discount" ? [...SESSION_PAYMENT_METHOD_KEYS, "discount"] : SESSION_PAYMENT_METHOD_KEYS;

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  /** A receipt already issued for `paidAt` or later means a future receipt for this
   * (earlier-dated) payment would get a higher document number than one already issued
   * for a later date — worth a warning before saving. */
  async function hasLaterIssuedReceipt(dateIso: string): Promise<boolean> {
    const { data, error } = await supabase.rpc("has_later_issued_receipt", {
      p_paid_at: dateIso,
      p_exclude_source_id: isEdit && editPayment ? editPayment.id : null,
    });
    if (error) return false; // fail open — don't block saving on a diagnostic query failure
    return data === true;
  }

  async function save() {
    const amt = Number.parseFloat(amount.replace(",", ".").trim());
    if (!Number.isFinite(amt) || amt <= 0) {
      showError(t("ui.addAccountPayment.enterAValidAmount"));
      return;
    }
    if (!payeeId.trim()) {
      showError(t("common.error"));
      return;
    }
    if (await hasLaterIssuedReceipt(paidAt.trim())) {
      showConfirm({
        title: t("billing.backdatedReceiptWarningTitle"),
        message: t("billing.backdatedReceiptWarningMessage"),
        cancelLabel: t("common.cancel"),
        confirmLabel: t("billing.saveAnyway"),
        confirmVariant: "danger",
        onConfirm: () => void performSave(amt),
      });
      return;
    }
    await performSave(amt);
  }

  async function performSave(amt: number) {
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

    // Explicit opt-in subscription payment: reuse the same manager-only, server-validated RPC
    // Subscription Detail's AddSubscriptionPaymentModal uses, rather than a second accounting
    // path -- the backend, not this toggle, is what actually enforces the subscription-id link.
    if (!isEdit && isSubscriptionPayment && activeSubscriptionId) {
      try {
        const res = await rpcRecordSubscriptionPayment(supabase, activeSubscriptionId, {
          amountIls: amt,
          paymentMethod: method,
          payerName: showPayerName ? payerName.trim() || null : null,
          note: note.trim() || null,
          paidAt: paidAt.trim(),
          clientRequestId: clientRequestIdRef.current,
        });
        setBusy(false);
        if (!res.ok) {
          showError(
            res.error === "invalid_subscription" || res.error === "subscription_not_found"
              ? t("subscriptions.detail.loadError")
              : res.error === "subscription_not_eligible_for_date"
                ? t("billing.subscriptionNotEligibleForDate")
                : t("subscriptions.genericError")
          );
          return;
        }
      } catch (e) {
        setBusy(false);
        showError(e instanceof Error ? e.message : t("subscriptions.genericError"));
        return;
      }
      setSuccess(true);
      await new Promise((resolve) => setTimeout(resolve, theme.motion.normal));
      setSuccess(false);
      onClose();
      showToast({ message: t("billing.paymentSaved"), variant: "success" });
      await onSaved();
      return;
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
      const msg = error.message.includes("account_payment_locked_receipt_issued")
        ? t("billing.cannotModifyPaymentMessage")
        : error.message.includes("account_payment_reversed_immutable")
          ? t("billing.cannotModifyReversedPaymentMessage")
          : error.message.includes("account_disabled_payee")
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
      backdropAccessibilityLabel={t("ui.addAccountPayment.dismiss")}
      cardStyle={styles.card}
    >
      <View style={[styles.header, rowFlipFor(isRTL) && styles.headerRtl]}>
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
          placeholderTextColor={theme.colors.fieldPlaceholder}
          style={[styles.input, isRTL && styles.inputRtl]}
          editable={!busy}
        />
        <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.method")}</Text>
        <View style={[styles.methodRow, rowFlipFor(isRTL) && styles.methodRowRtl]}>
          {methodChoices.map((m) => {
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
        {!isEdit && !eligibilityLoading && activeSubscriptionId ? (
          <Pressable
            onPress={() => setIsSubscriptionPayment((v) => !v)}
            disabled={busy}
            style={({ pressed }) => [styles.subPayToggleRow, rowFlipFor(isRTL) && styles.subPayToggleRowRtl, pressed && { opacity: 0.9 }]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isSubscriptionPayment }}
          >
            <View style={[styles.subPayCheckbox, isSubscriptionPayment && styles.subPayCheckboxOn]}>
              {isSubscriptionPayment ? <Text style={styles.subPayCheckboxMark}>✓</Text> : null}
            </View>
            <View style={styles.subPayToggleTextWrap}>
              <Text style={[styles.subPayToggleLabel, isRTL && styles.rtlText]}>{t("billing.isSubscriptionPayment")}</Text>
              <Text style={[styles.subPayToggleHint, isRTL && styles.rtlText]}>{t("billing.isSubscriptionPaymentHint")}</Text>
            </View>
          </Pressable>
        ) : null}
        {showPayerName ? (
          <>
            <Text style={[styles.label, isRTL && styles.rtlText]}>{t("families.payerNameLabel")}</Text>
            <TextInput
              value={payerName}
              onChangeText={setPayerName}
              placeholder={t("families.payerNamePlaceholder")}
              placeholderTextColor={theme.colors.fieldPlaceholder}
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
          placeholderTextColor={theme.colors.fieldPlaceholder}
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
  subPayToggleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 6,
    padding: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.infoBorder,
    backgroundColor: theme.colors.infoBg,
  },
  subPayToggleRowRtl: { flexDirection: "row-reverse" },
  subPayCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: theme.colors.info,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  subPayCheckboxOn: { backgroundColor: theme.colors.info },
  subPayCheckboxMark: { fontSize: 13, fontWeight: "800", color: theme.colors.background },
  subPayToggleTextWrap: { flex: 1, minWidth: 0 },
  subPayToggleLabel: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  subPayToggleHint: { fontSize: 12, lineHeight: 16, color: theme.colors.textMuted, marginTop: 2 },
});
