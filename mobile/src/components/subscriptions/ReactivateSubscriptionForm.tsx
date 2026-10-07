import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { useDiscardChangesPrompt } from "../../hooks/useDiscardChangesPrompt";
import { supabase } from "../../lib/supabase";
import { sessionFormStyles as sf } from "../sessionFormStyles";
import { AppSwitch } from "../AppSwitch";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import {
  emptyWeeklyLimits,
  rpcGetSubscriptionDetail,
  rpcReactivateSubscription,
  tierLabelKey,
  type SubscriptionTier,
  type WeeklyLimits,
} from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";

export function ReactivateSubscriptionForm({ sourceSubscriptionId }: { sourceSubscriptionId: string }) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourcePrice, setSourcePrice] = useState(0);
  const [sourceAllowances, setSourceAllowances] = useState<WeeklyLimits>(emptyWeeklyLimits());

  const today = toISODateLocal(new Date());
  const [startDate, setStartDate] = useState(today);
  const [noEndDate, setNoEndDate] = useState(true);
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const allowLeaveRef = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = startDate !== today || !noEndDate || endDate !== "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await rpcGetSubscriptionDetail(supabase, sourceSubscriptionId);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        const versions = [...res.versions].sort((a, b) => a.version_no - b.version_no);
        const latest = versions[versions.length - 1];
        setSourcePrice(latest?.monthly_price_ils ?? 0);
        setSourceAllowances(latest?.allowances ?? emptyWeeklyLimits());
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : t("subscriptions.detail.loadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceSubscriptionId, t]);

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || !dirtyRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("sessionForm.unsavedTitle"),
        t("sessionForm.unsavedEditBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          allowLeaveRef.current = true;
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t, promptDiscardChanges]);

  function confirmLeaveThen(go: () => void) {
    if (!dirtyRef.current) {
      allowLeaveRef.current = true;
      go();
      return;
    }
    promptDiscardChanges(
      t("sessionForm.unsavedTitle"),
      t("sessionForm.unsavedEditBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      () => {
        allowLeaveRef.current = true;
        go();
      }
    );
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
      allowLeaveRef.current = true;
      router.replace(`/(app)/manager/subscriptions/${res.subscription_id}`);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.cta} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{loadError}</Text>
      </View>
    );
  }

  const activeTiers = (Object.keys(sourceAllowances) as SubscriptionTier[]).filter((tier) => (sourceAllowances[tier] ?? 0) > 0);

  return (
    <>
      <ScrollView contentContainerStyle={sf.content} style={sf.screen} keyboardShouldPersistTaps="handled">
        <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl, styles.explanation]}>{t("subscriptions.reactivate.explanation")}</Text>
            <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>₪{sourcePrice.toFixed(2)}</Text>
            {activeTiers.map((tier) => (
              <Text key={tier} style={[styles.summarySub, isRTL && styles.rtlText]}>
                {t(tierLabelKey(tier))} — {sourceAllowances[tier]} {t("subscriptions.perWeek")}
              </Text>
            ))}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.reactivate.startDateLabel")}</Text>
            <DatePickerField appearance="embedded" label={t("subscriptions.reactivate.startDateLabel")} value={startDate} onChange={setStartDate} />

            <View style={[styles.toggleRow, styles.spaced, rowFlipFor(isRTL) && styles.toggleRowRtl]}>
              <Text style={[sf.label, isRTL && sf.labelRtl]}>{t("subscriptions.reactivate.noEndDateToggle")}</Text>
              <AppSwitch value={noEndDate} onValueChange={setNoEndDate} accessibilityLabel={t("subscriptions.reactivate.noEndDateToggle")} />
            </View>
            {!noEndDate ? (
              <View style={styles.spaced}>
                <DatePickerField
                  appearance="embedded"
                  label={t("subscriptions.reactivate.endDateLabel")}
                  value={endDate}
                  onChange={setEndDate}
                  minimumDate={startDate ? new Date(startDate) : undefined}
                />
              </View>
            ) : null}
          </View>

          <View style={styles.footer}>
            <PrimaryButton label={t("subscriptions.reactivate.submit")} onPress={() => void submit()} loading={submitting} loadingLabel={t("common.loading")} />
            <Pressable
              onPress={() => confirmLeaveThen(() => router.back())}
              style={({ pressed }) => [styles.secondaryAction, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
            >
              <Text style={styles.secondaryActionTxt}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  errorText: { color: theme.colors.error, fontWeight: "700", padding: theme.spacing.lg },
  explanation: { marginTop: 0, marginBottom: theme.spacing.sm },
  summaryLine: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  summarySub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, marginTop: 2 },
  spaced: { marginTop: theme.spacing.md },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  footer: { gap: theme.spacing.sm, paddingTop: theme.spacing.xs },
  secondaryAction: { paddingVertical: theme.spacing.sm, alignItems: "center", minHeight: 44, justifyContent: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  rtlText: { textAlign: "right" },
});
