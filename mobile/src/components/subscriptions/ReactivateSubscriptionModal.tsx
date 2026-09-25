import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { AppSwitch } from "../AppSwitch";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { rpcReactivateSubscription, tierLabelKey, type SubscriptionTier, type WeeklyLimits } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  sourceSubscriptionId: string;
  sourcePrice: number;
  sourceAllowances: WeeklyLimits;
  onClose: () => void;
  onCreated: (newSubscriptionId: string) => void;
};

export function ReactivateSubscriptionModal({
  visible,
  sourceSubscriptionId,
  sourcePrice,
  sourceAllowances,
  onClose,
  onCreated,
}: Props) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();

  const [startDate, setStartDate] = useState(toISODateLocal(new Date()));
  const [noEndDate, setNoEndDate] = useState(true);
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStartDate(toISODateLocal(new Date()));
    setNoEndDate(true);
    setEndDate("");
    setSubmitting(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await rpcReactivateSubscription(supabase, sourceSubscriptionId, startDate, noEndDate ? null : endDate || null);
      if (!res.ok) {
        const msg = res.error === "conflicting_active_subscription" ? t("subscriptions.create.conflict") : t("subscriptions.genericError");
        showToast({ message: msg, variant: "error" });
        return;
      }
      showToast({ message: t("subscriptions.reactivate.success"), variant: "success" });
      reset();
      onCreated(res.subscription_id);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const activeTiers = (Object.keys(sourceAllowances) as SubscriptionTier[]).filter((tier) => (sourceAllowances[tier] ?? 0) > 0);

  return (
    <AppModal visible={visible} onClose={handleClose} variant="sheet" backdropAccessibilityLabel={t("common.cancel")}>
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.reactivate.title")}</Text>
      </View>
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.explanation, isRTL && styles.rtl]}>{t("subscriptions.reactivate.explanation")}</Text>

        <View style={[styles.summaryBox, styles.spaced]}>
          <Text style={[styles.summaryLine, isRTL && styles.rtl]}>₪{sourcePrice.toFixed(2)}</Text>
          {activeTiers.map((tier) => (
            <Text key={tier} style={[styles.summarySub, isRTL && styles.rtl]}>
              {t(tierLabelKey(tier))} — {sourceAllowances[tier]} {t("subscriptions.perWeek")}
            </Text>
          ))}
        </View>

        <View style={styles.spaced}>
          <DatePickerField appearance="standalone" label={t("subscriptions.reactivate.startDateLabel")} value={startDate} onChange={setStartDate} />
        </View>

        <View style={[styles.toggleRow, styles.spaced, isRTL && styles.toggleRowRtl]}>
          <Text style={[styles.label, isRTL && styles.rtl]}>{t("subscriptions.reactivate.noEndDateToggle")}</Text>
          <AppSwitch value={noEndDate} onValueChange={setNoEndDate} accessibilityLabel={t("subscriptions.reactivate.noEndDateToggle")} />
        </View>
        {!noEndDate ? (
          <View style={styles.spaced}>
            <DatePickerField appearance="standalone" label={t("subscriptions.reactivate.endDateLabel")} value={endDate} onChange={setEndDate} minimumDate={startDate ? new Date(startDate) : undefined} />
          </View>
        ) : null}

        <PrimaryButton label={t("subscriptions.reactivate.submit")} onPress={() => void submit()} loading={submitting} disabled={submitting} style={styles.submitBtn} />
      </ScrollView>
    </AppModal>
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
  explanation: { fontSize: 14, fontWeight: "500", color: theme.colors.textMuted, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  spaced: { marginTop: theme.spacing.md },
  summaryBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: 4,
  },
  summaryLine: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  summarySub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  submitBtn: { marginTop: theme.spacing.lg, marginBottom: theme.spacing.xl },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
