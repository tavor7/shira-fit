import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
import { AllowancesEditor } from "./AllowancesEditor";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import {
  emptyWeeklyLimits,
  rpcEditSubscriptionVersion,
  rpcGetSubscriptionDetail,
  type SubscriptionImpact,
  type WeeklyLimits,
} from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";
import { useScreenContentStyle } from "../../hooks/useScreenLayout";

type Mode = "beginning" | "date";

/** Full pushed-screen edit form (was a modal; converted to match this app's actual creation/edit
 * screen convention). Fetches its own fresh copy of the subscription (never trusts data carried
 * over from the detail screen's last render), mirrors edit_subscription_version's mandatory
 * impact-preview/confirm pattern via the shared SubscriptionImpactConfirmModal, which stays a real
 * modal layered on top of this still-mounted screen. */
export function EditSubscriptionForm({ subscriptionId }: { subscriptionId: string }) {
  const { t, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showToast } = useToast();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subscriptionStartDate, setSubscriptionStartDate] = useState("");

  const [mode, setMode] = useState<Mode>("date");
  const [effectiveDate, setEffectiveDate] = useState(toISODateLocal(new Date()));
  const [price, setPrice] = useState("");
  const [clearEndDate, setClearEndDate] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [allowances, setAllowances] = useState<WeeklyLimits>(emptyWeeklyLimits());
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);

  const allowLeaveRef = useRef(false);
  const baselineRef = useRef<string | null>(null);
  const formSerialized = useMemo(
    () => JSON.stringify({ mode, effectiveDate, price, clearEndDate, endDate, allowances }),
    [mode, effectiveDate, price, clearEndDate, endDate, allowances]
  );
  const formSerializedRef = useRef(formSerialized);
  formSerializedRef.current = formSerialized;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await rpcGetSubscriptionDetail(supabase, subscriptionId);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        const versions = [...res.versions].sort((a, b) => a.version_no - b.version_no);
        const current = versions.find((v) => v.effective_to === null) ?? versions[versions.length - 1];
        setSubscriptionStartDate(versions[0]?.plan_start_date ?? current?.plan_start_date ?? "");
        setPrice(String(current?.monthly_price_ils ?? 0));
        setClearEndDate(current?.plan_end_date == null);
        setEndDate(current?.plan_end_date ?? "");
        setAllowances(current?.allowances ?? emptyWeeklyLimits());
        baselineRef.current = JSON.stringify({
          mode: "date",
          effectiveDate: toISODateLocal(new Date()),
          price: String(current?.monthly_price_ils ?? 0),
          clearEndDate: current?.plan_end_date == null,
          endDate: current?.plan_end_date ?? "",
          allowances: current?.allowances ?? emptyWeeklyLimits(),
        });
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : t("subscriptions.detail.loadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionId, t]);

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current) return;
      if (baselineRef.current === null || formSerializedRef.current === baselineRef.current) return;
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
    if (baselineRef.current === null || formSerializedRef.current === baselineRef.current) {
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
      allowLeaveRef.current = true;
      router.back();
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
        <Text style={[styles.errorText, isRTL && styles.rtlText]}>{loadError}</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={[sf.content, screenContent]} style={sf.screen} keyboardShouldPersistTaps="handled">
        <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.edit.modeLabel")}</Text>
            <View style={[styles.modeRow, rowFlipFor(isRTL) && styles.modeRowRtl]}>
              <ModeChip label={t("subscriptions.edit.modeFromBeginning")} active={mode === "beginning"} onPress={() => setMode("beginning")} />
              <ModeChip label={t("subscriptions.edit.modeFromDate")} active={mode === "date"} onPress={() => setMode("date")} />
            </View>
            {mode === "beginning" ? (
              <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl]}>{t("subscriptions.edit.modeFromBeginningHint")}</Text>
            ) : (
              <View style={styles.spaced}>
                <DatePickerField appearance="embedded" label={t("subscriptions.edit.effectiveDateLabel")} value={effectiveDate} onChange={setEffectiveDate} />
              </View>
            )}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.edit.priceLabel")}</Text>
            <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" inputMode="decimal" style={[sf.control, sf.controlInput, isRTL && styles.rtlInput]} />
          </View>

          <View style={sf.card}>
            <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.toggleRowRtl]}>
              <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.edit.clearEndDateToggle")}</Text>
              <AppSwitch value={clearEndDate} onValueChange={setClearEndDate} accessibilityLabel={t("subscriptions.edit.clearEndDateToggle")} />
            </View>
            {!clearEndDate ? (
              <View style={styles.spaced}>
                <DatePickerField appearance="embedded" label={t("subscriptions.edit.endDateLabel")} value={endDate} onChange={setEndDate} />
              </View>
            ) : null}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.edit.allowancesLabel")}</Text>
            <AllowancesEditor value={allowances} onChange={setAllowances} label="" />
          </View>

          <View style={styles.footer}>
            <PrimaryButton label={t("subscriptions.edit.submit")} onPress={() => void runEdit(false)} loading={submitting} loadingLabel={t("common.loading")} />
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
      <SubscriptionImpactConfirmModal
        visible={impactOpen}
        action="edit"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => void runEdit(true)}
      />
      {discardDialog}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  errorText: { color: theme.colors.error, fontWeight: "700", padding: theme.spacing.lg },
  spaced: { marginTop: theme.spacing.md },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  modeRow: { flexDirection: "row", gap: 8 },
  modeRowRtl: { flexDirection: "row-reverse" },
  chip: {
    flexGrow: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
  },
  chipActive: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  chipText: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  chipTextActive: { color: theme.colors.ctaText },
  footer: { gap: theme.spacing.sm, paddingTop: theme.spacing.xs },
  secondaryAction: { paddingVertical: theme.spacing.sm, alignItems: "center", minHeight: 44, justifyContent: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  rtlText: { textAlign: "right" },
  rtlInput: { textAlign: "right" },
});
