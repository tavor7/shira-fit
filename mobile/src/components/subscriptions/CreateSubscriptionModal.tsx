import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { AppSwitch } from "../AppSwitch";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { PayeePickerModal, type PayeePickerRow } from "../PayeePickerModal";
import { formatISODateFull } from "../../lib/dateFormat";
import { toISODateLocal } from "../../lib/isoDate";
import { AllowancesEditor } from "./AllowancesEditor";
import {
  emptyWeeklyLimits,
  rpcCreateSubscription,
  validateCreateSubscriptionInput,
  type WeeklyLimits,
} from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (subscriptionId: string) => void;
};

export function CreateSubscriptionModal({ visible, onClose, onCreated }: Props) {
  const { t, language, isRTL } = useI18n();
  const { showToast } = useToast();

  const [payeePickerOpen, setPayeePickerOpen] = useState(false);
  const [payee, setPayee] = useState<PayeePickerRow | null>(null);
  const [price, setPrice] = useState("");
  const [startDate, setStartDate] = useState(toISODateLocal(new Date()));
  const [noEndDate, setNoEndDate] = useState(true);
  const [endDate, setEndDate] = useState("");
  const [allowances, setAllowances] = useState<WeeklyLimits>(emptyWeeklyLimits());
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setPayee(null);
    setPrice("");
    setStartDate(toISODateLocal(new Date()));
    setNoEndDate(true);
    setEndDate("");
    setAllowances(emptyWeeklyLimits());
    setErrors(new Set());
    setSubmitting(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  const priceNum = Number.parseFloat(price.replace(",", "."));

  const input = useMemo(
    () => ({
      payeeId: payee?.id ?? "",
      payeeIsManual: payee?.kind === "manual",
      monthlyPriceIls: priceNum,
      startDate,
      endDate: noEndDate ? null : endDate || null,
      allowances,
    }),
    [payee, priceNum, startDate, noEndDate, endDate, allowances]
  );

  async function submit() {
    if (submitting) return; // duplicate-submit protection
    const problems = validateCreateSubscriptionInput(input);
    if (problems.length > 0) {
      setErrors(new Set(problems.map((p) => p.field)));
      return;
    }
    setErrors(new Set());
    setSubmitting(true);
    try {
      const res = await rpcCreateSubscription(supabase, input);
      if (!res.ok) {
        const msg = res.error === "conflicting_active_subscription" ? t("subscriptions.create.conflict") : t("subscriptions.genericError");
        showToast({ message: msg, variant: "error" });
        return;
      }
      showToast({ message: t("subscriptions.create.success"), variant: "success" });
      reset();
      onCreated(res.subscription_id);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const summaryLine = payee && Number.isFinite(priceNum) && priceNum >= 0
    ? t("subscriptions.create.summaryLine")
        .replace("{name}", payee.full_name)
        .replace("{price}", priceNum.toFixed(2))
        .replace("{start}", formatISODateFull(startDate, language))
    : null;

  return (
    <>
      <AppModal visible={visible} onClose={handleClose} variant="sheet" backdropAccessibilityLabel={t("common.cancel")}>
        <View style={[styles.header, isRTL && styles.headerRtl]}>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.create.title")}</Text>
        </View>
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.label, isRTL && styles.rtl]}>{t("subscriptions.create.payeeLabel")}</Text>
          <PrimaryButton
            label={payee ? payee.full_name : t("subscriptions.create.pickPayee")}
            onPress={() => setPayeePickerOpen(true)}
            variant="ghost"
          />
          {errors.has("payee") ? <Text style={styles.err}>{t("subscriptions.errPayeeRequired")}</Text> : null}

          <Text style={[styles.label, styles.spaced, isRTL && styles.rtl]}>{t("subscriptions.create.priceLabel")}</Text>
          <TextInput
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="0"
            style={[styles.input, isRTL && styles.inputRtl]}
          />
          {errors.has("price") ? <Text style={styles.err}>{t("subscriptions.errPriceInvalid")}</Text> : null}

          <Text style={[styles.label, styles.spaced, isRTL && styles.rtl]}>{t("subscriptions.create.startDateLabel")}</Text>
          <DatePickerField appearance="standalone" label={t("subscriptions.create.startDateLabel")} value={startDate} onChange={setStartDate} />
          {errors.has("startDate") ? <Text style={styles.err}>{t("subscriptions.errStartDateInvalid")}</Text> : null}

          <View style={[styles.toggleRow, styles.spaced, isRTL && styles.toggleRowRtl]}>
            <Text style={[styles.label, isRTL && styles.rtl]}>{t("subscriptions.create.noEndDateToggle")}</Text>
            <AppSwitch value={noEndDate} onValueChange={setNoEndDate} accessibilityLabel={t("subscriptions.create.noEndDateToggle")} />
          </View>
          {!noEndDate ? (
            <View style={styles.spaced}>
              <DatePickerField appearance="standalone" label={t("subscriptions.create.endDateLabel")} value={endDate} onChange={setEndDate} minimumDate={startDate ? new Date(startDate) : undefined} />
              {errors.has("endDate") ? <Text style={styles.err}>{t("subscriptions.errEndDateInvalid")}</Text> : null}
            </View>
          ) : null}

          <View style={styles.spaced}>
            <AllowancesEditor
              value={allowances}
              onChange={setAllowances}
              label={t("subscriptions.create.allowancesLabel")}
              hint={t("subscriptions.create.allowancesHint")}
            />
          </View>

          {summaryLine ? (
            <View style={[styles.summaryBox, styles.spaced]}>
              <Text style={[styles.summaryTitle, isRTL && styles.rtl]}>{t("subscriptions.create.summaryTitle")}</Text>
              <Text style={[styles.summaryLine, isRTL && styles.rtl]}>{summaryLine}</Text>
              <Text style={[styles.summaryLine, isRTL && styles.rtl]}>
                {noEndDate
                  ? t("subscriptions.create.summaryNoEnd")
                  : endDate
                    ? t("subscriptions.create.summaryEnd").replace("{end}", formatISODateFull(endDate, language))
                    : ""}
              </Text>
            </View>
          ) : null}

          <PrimaryButton
            label={t("subscriptions.create.submit")}
            onPress={() => void submit()}
            loading={submitting}
            disabled={submitting}
            style={styles.submitBtn}
          />
        </ScrollView>
      </AppModal>
      <PayeePickerModal visible={payeePickerOpen} onClose={() => setPayeePickerOpen(false)} onSelect={setPayee} />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flex: 1 },
  body: { padding: theme.spacing.md },
  label: { fontSize: 13, fontWeight: "800", color: theme.colors.text, marginBottom: 6 },
  spaced: { marginTop: theme.spacing.md },
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
  err: { color: theme.colors.error, fontSize: 12, fontWeight: "700", marginTop: 4 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  summaryBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: 4,
  },
  summaryTitle: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase" },
  summaryLine: { fontSize: 14, fontWeight: "600", color: theme.colors.text, lineHeight: 20 },
  submitBtn: { marginTop: theme.spacing.lg, marginBottom: theme.spacing.xl },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
