import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { supabase } from "../lib/supabase";
import { AppText } from "../components/AppText";
import { EmptyState } from "../components/EmptyState";
import { WeeklyAllowanceMeter } from "../components/WeeklyAllowanceMeter";
import { formatISODateFull } from "../lib/dateFormat";
import { formatIls } from "../lib/documents";
import { tierLabelKey } from "../lib/subscriptions";
import {
  buildAthleteSubscriptionViewModel,
  resumeDateFromFreezeUntil,
  rpcGetMySubscription,
  sessionsLeftLabel,
  usedOfLimitLabel,
  type AthleteSubscriptionViewModel,
} from "../lib/athleteSubscription";
import { rowFlipFor } from "../lib/layoutDirection";

export function AthleteSubscriptionScreen() {
  const { t, language, isRTL } = useI18n();
  const [vm, setVm] = useState<AthleteSubscriptionViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rpcGetMySubscription(supabase);
      if (!res.ok) {
        setError(res.error);
        setVm(null);
        return;
      }
      setVm(buildAthleteSubscriptionViewModel(res));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("athleteSubscription.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Refetch on every focus so returning from registering/cancelling a session never shows stale
  // usage numbers.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (loading && !vm) {
    return (
      <View style={styles.centerScreen}>
        <ActivityIndicator color={theme.colors.cta} />
      </View>
    );
  }

  if (error || !vm) {
    return (
      <View style={styles.screen}>
        <EmptyState
          icon="⚠️"
          title={t("athleteSubscription.loadError")}
          actionLabel={t("athleteSubscription.retry")}
          onAction={() => void load()}
          isRTL={isRTL}
        />
      </View>
    );
  }

  if (vm.kind === "none") {
    return (
      <View style={styles.screen}>
        <EmptyState title={t("athleteSubscription.noSubscriptionTitle")} body={t("athleteSubscription.noSubscriptionBody")} isRTL={isRTL} />
      </View>
    );
  }

  const isFrozen = vm.kind === "frozen";

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {isFrozen && vm.currentFreeze ? (
          <View style={styles.frozenCard}>
            <AppText variant="title" isRTL={isRTL} style={styles.frozenTitle}>
              {t("athleteSubscription.frozenTitle")}
            </AppText>
            <AppText variant="body" isRTL={isRTL} style={styles.frozenRange}>
              {t("athleteSubscription.frozenRange")
                .replace("{from}", formatISODateFull(vm.currentFreeze.freeze_from, language))
                .replace("{until}", formatISODateFull(vm.currentFreeze.freeze_until, language))}
            </AppText>
            <AppText variant="caption" isRTL={isRTL} style={styles.frozenNote}>
              {t("athleteSubscription.frozenResumeNotice").replace(
                "{date}",
                formatISODateFull(resumeDateFromFreezeUntil(vm.currentFreeze.freeze_until), language)
              )}
            </AppText>
            <AppText variant="caption" muted isRTL={isRTL} style={styles.frozenNote}>
              {t("athleteSubscription.frozenSessionsNote")}
            </AppText>
            <AppText variant="caption" muted isRTL={isRTL} style={styles.frozenNote}>
              {t("athleteSubscription.frozenClockPaused")}
            </AppText>
          </View>
        ) : (
          <View style={styles.summaryCard}>
            <AppText variant="label" isRTL={isRTL} style={styles.summaryLabel}>
              {t("athleteSubscription.activeLabel")}
            </AppText>
            <AppText variant="display" isRTL={isRTL} style={styles.summaryPrice}>
              {t("athleteSubscription.priceLine").replace("{price}", formatIls(vm.monthlyPriceIls))}
            </AppText>
            {vm.nextBillingDate ? (
              <View style={[styles.summaryRow, rowFlipFor(isRTL) && styles.summaryRowRtl]}>
                <AppText variant="caption" muted isRTL={isRTL}>
                  {t("athleteSubscription.nextBilling")}
                </AppText>
                <AppText variant="caption" isRTL={isRTL} style={styles.summaryValue}>
                  {formatISODateFull(vm.nextBillingDate, language)}
                </AppText>
              </View>
            ) : null}
            {!vm.hasNoEndDate && vm.planEndDate ? (
              <View style={[styles.summaryRow, rowFlipFor(isRTL) && styles.summaryRowRtl]}>
                <AppText variant="caption" muted isRTL={isRTL}>
                  {t("athleteSubscription.validUntil")}
                </AppText>
                <AppText variant="caption" isRTL={isRTL} style={styles.summaryValue}>
                  {formatISODateFull(vm.planEndDate, language)}
                </AppText>
              </View>
            ) : null}
          </View>
        )}

        {vm.upcomingFreeze ? (
          <View style={styles.upcomingFreezeNotice}>
            <AppText variant="caption" isRTL={isRTL} style={styles.upcomingFreezeTitle}>
              {t("athleteSubscription.upcomingFreezeTitle")}
            </AppText>
            <AppText variant="caption" muted isRTL={isRTL}>
              {t("athleteSubscription.frozenRange")
                .replace("{from}", formatISODateFull(vm.upcomingFreeze.freeze_from, language))
                .replace("{until}", formatISODateFull(vm.upcomingFreeze.freeze_until, language))}
            </AppText>
          </View>
        ) : null}

        {vm.tiers.length > 0 ? (
          <View style={styles.section}>
            <View style={[styles.sectionHeaderRow, rowFlipFor(isRTL) && styles.sectionHeaderRowRtl]}>
              <AppText variant="headline" isRTL={isRTL}>
                {t("athleteSubscription.thisWeekTitle")}
              </AppText>
              <AppText variant="caption" muted isRTL={isRTL}>
                {t("athleteSubscription.resetsSunday")}
              </AppText>
            </View>
            {vm.tiers.map((tier, idx) => (
              <View key={tier.tier} style={[styles.meterRow, idx > 0 && styles.meterRowDivider]}>
                <WeeklyAllowanceMeter
                  title={t(tierLabelKey(tier.tier))}
                  used={tier.used}
                  limit={tier.weeklyLimit}
                  usedLabel={usedOfLimitLabel(tier.used, tier.weeklyLimit, t)}
                  statusLabel={tier.exhausted ? t("athleteSubscription.allowanceUsedUp") : sessionsLeftLabel(tier.remaining, t)}
                  noteLabel={tier.exhausted ? t("athleteSubscription.extraAtRegularPrice") : undefined}
                  exhausted={tier.exhausted}
                  isRTL={isRTL}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <AppText variant="headline" isRTL={isRTL} style={styles.sectionTitle}>
            {t("athleteSubscription.detailsTitle")}
          </AppText>
          <KeyValue label={t("athleteSubscription.detailPrice")} value={formatIls(vm.monthlyPriceIls)} isRTL={isRTL} />
          <KeyValue label={t("athleteSubscription.detailStart")} value={formatISODateFull(vm.planStartDate, language)} isRTL={isRTL} />
          {!vm.hasNoEndDate && vm.planEndDate ? (
            <KeyValue label={t("athleteSubscription.detailEnd")} value={formatISODateFull(vm.planEndDate, language)} isRTL={isRTL} />
          ) : null}
          {vm.nextBillingDate ? (
            <KeyValue label={t("athleteSubscription.detailNextBilling")} value={formatISODateFull(vm.nextBillingDate, language)} isRTL={isRTL} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function KeyValue({ label, value, isRTL }: { label: string; value: string; isRTL: boolean }) {
  return (
    <View style={[styles.kv, rowFlipFor(isRTL) && styles.kvRtl]}>
      <AppText variant="caption" muted isRTL={isRTL}>
        {label}
      </AppText>
      <AppText variant="caption" isRTL={isRTL} style={styles.kvValue}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  centerScreen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, alignItems: "center", justifyContent: "center" },
  scroll: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  summaryCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
  },
  summaryLabel: { color: theme.colors.success, textTransform: "uppercase" },
  summaryPrice: { marginTop: 6, marginBottom: theme.spacing.sm },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  summaryRowRtl: { flexDirection: "row-reverse" },
  summaryValue: { fontWeight: "800", color: theme.colors.text },
  frozenCard: {
    backgroundColor: theme.colors.infoBg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.infoBorder,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
  },
  frozenTitle: { color: theme.colors.text },
  frozenRange: { marginTop: 6, fontWeight: "800", color: theme.colors.text },
  frozenNote: { marginTop: 8 },
  upcomingFreezeNotice: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  upcomingFreezeTitle: { fontWeight: "800", color: theme.colors.textMuted, marginBottom: 2 },
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  sectionTitle: { marginBottom: theme.spacing.xs },
  sectionHeaderRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 },
  sectionHeaderRowRtl: { flexDirection: "row-reverse" },
  meterRow: {},
  meterRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderMuted },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm, paddingVertical: 4 },
  kvRtl: { flexDirection: "row-reverse" },
  kvValue: { fontWeight: "800", color: theme.colors.text },
});
