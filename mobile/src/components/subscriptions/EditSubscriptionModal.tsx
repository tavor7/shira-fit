import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { AppSwitch } from "../AppSwitch";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { AllowancesEditor } from "./AllowancesEditor";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import { rpcEditSubscriptionVersion, type SubscriptionImpact, type WeeklyLimits } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  subscriptionId: string;
  subscriptionStartDate: string;
  currentPrice: number;
  currentEndDate: string | null;
  currentAllowances: WeeklyLimits;
  onClose: () => void;
  onSaved: () => void;
};

type Mode = "beginning" | "date";

export function EditSubscriptionModal({
  visible,
  subscriptionId,
  subscriptionStartDate,
  currentPrice,
  currentEndDate,
  currentAllowances,
  onClose,
  onSaved,
}: Props) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();

  const [mode, setMode] = useState<Mode>("date");
  const [effectiveDate, setEffectiveDate] = useState(toISODateLocal(new Date()));
  const [price, setPrice] = useState(String(currentPrice));
  const [clearEndDate, setClearEndDate] = useState(currentEndDate == null);
  const [endDate, setEndDate] = useState(currentEndDate ?? "");
  const [allowances, setAllowances] = useState<WeeklyLimits>(currentAllowances);
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);

  function reset() {
    setMode("date");
    setEffectiveDate(toISODateLocal(new Date()));
    setPrice(String(currentPrice));
    setClearEndDate(currentEndDate == null);
    setEndDate(currentEndDate ?? "");
    setAllowances(currentAllowances);
    setSubmitting(false);
    setImpact(null);
    setImpactOpen(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function runEdit(confirmed: boolean) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const priceNum = Number.parseFloat(price.replace(",", "."));
      const res = await rpcEditSubscriptionVersion(supabase, {
        subscriptionId,
        effectiveFrom: mode === "beginning" ? subscriptionStartDate : effectiveDate,
        newPrice: Number.isFinite(priceNum) ? priceNum : null,
        newPlanEndDate: clearEndDate ? null : endDate || null,
        clearEndDate,
        newAllowances: allowances,
        confirmed,
      });
      if (!res.ok) {
        showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        return;
      }
      if (res.action === "preview") {
        setImpact(res.impact ?? null);
        setImpactOpen(true);
        return;
      }
      showToast({ message: t("subscriptions.edit.success"), variant: "success" });
      setImpactOpen(false);
      reset();
      onSaved();
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <AppModal visible={visible && !impactOpen} onClose={handleClose} variant="sheet" backdropAccessibilityLabel={t("common.cancel")}>
        <View style={[styles.header, isRTL && styles.headerRtl]}>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.edit.title")}</Text>
        </View>
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.label, isRTL && styles.rtl]}>{t("subscriptions.edit.modeLabel")}</Text>
          <View style={[styles.modeRow, isRTL && styles.modeRowRtl]}>
            <ModeChip label={t("subscriptions.edit.modeFromBeginning")} active={mode === "beginning"} onPress={() => setMode("beginning")} />
            <ModeChip label={t("subscriptions.edit.modeFromDate")} active={mode === "date"} onPress={() => setMode("date")} />
          </View>
          {mode === "beginning" ? (
            <Text style={[styles.hint, isRTL && styles.rtl]}>{t("subscriptions.edit.modeFromBeginningHint")}</Text>
          ) : (
            <View style={styles.spaced}>
              <DatePickerField appearance="standalone" label={t("subscriptions.edit.effectiveDateLabel")} value={effectiveDate} onChange={setEffectiveDate} />
            </View>
          )}

          <Text style={[styles.label, styles.spaced, isRTL && styles.rtl]}>{t("subscriptions.edit.priceLabel")}</Text>
          <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" inputMode="decimal" style={[styles.input, isRTL && styles.inputRtl]} />

          <View style={[styles.toggleRow, styles.spaced, isRTL && styles.toggleRowRtl]}>
            <Text style={[styles.label, isRTL && styles.rtl]}>{t("subscriptions.edit.clearEndDateToggle")}</Text>
            <AppSwitch value={clearEndDate} onValueChange={setClearEndDate} accessibilityLabel={t("subscriptions.edit.clearEndDateToggle")} />
          </View>
          {!clearEndDate ? (
            <View style={styles.spaced}>
              <DatePickerField appearance="standalone" label={t("subscriptions.edit.endDateLabel")} value={endDate} onChange={setEndDate} />
            </View>
          ) : null}

          <View style={styles.spaced}>
            <AllowancesEditor value={allowances} onChange={setAllowances} label={t("subscriptions.edit.allowancesLabel")} />
          </View>

          <PrimaryButton label={t("subscriptions.edit.submit")} onPress={() => void runEdit(false)} loading={submitting} disabled={submitting} style={styles.submitBtn} />
        </ScrollView>
      </AppModal>
      <SubscriptionImpactConfirmModal
        visible={impactOpen}
        action="edit"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => void runEdit(true)}
      />
    </>
  );
}

function ModeChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
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
  hint: { fontSize: 12, fontWeight: "500", color: theme.colors.textSoft, marginTop: 6, lineHeight: 17 },
  modeRow: { flexDirection: "row", gap: 8 },
  modeRowRtl: { flexDirection: "row-reverse" },
  chip: {
    flexGrow: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
  },
  chipActive: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  chipText: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  chipTextActive: { color: theme.colors.ctaText },
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
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  submitBtn: { marginTop: theme.spacing.lg, marginBottom: theme.spacing.xl },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
