import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, type Href } from "expo-router";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { supabase } from "../../lib/supabase";
import { formatISODateDayMonth } from "../../lib/dateFormat";
import { displayMoney } from "../../lib/displayFormat";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import { addStudioWeeksIso, weekBoundsSunday } from "../../lib/studioWeek";
import {
  rpcManagerSubscriptionOverviewBreakdown,
  rpcManagerSubscriptionOverviewStats,
  rpcManagerSubscriptionWeekUtilization,
  type SubscriptionOverviewBreakdownRow,
  type SubscriptionOverviewStats,
  type SubscriptionWeekUtilization,
} from "../../lib/subscriptions";
import { buildOverviewAttention, buildUtilizationViewModel, type UtilizationLegendKey } from "../../lib/subscriptionUtilization";
import { AnimatedOptionExpand } from "../AnimatedOptionExpand";
import { SubscriptionCorrectionsModal } from "./SubscriptionCorrectionsModal";

type Props = {
  /** The Overview's selected money period. */
  rangeStart: string;
  rangeEnd: string;
  /** A date inside the week to open on. */
  anchorDate: string;
};

type Filter = "all" | "open" | "frozen";

const LEGEND_COLOR: Record<UtilizationLegendKey, string> = {
  used: theme.colors.success,
  unmarked: theme.colors.textSoft,
  reserved: theme.colors.alertSubject,
  remaining: theme.colors.borderInput,
  unused: theme.colors.borderInput,
};

function statusLabelKey(status: string): string {
  switch (status) {
    case "frozen":
      return "subscriptions.statusFrozen";
    case "scheduled":
      return "subscriptions.statusScheduled";
    case "stopped":
      return "subscriptions.statusStopped";
    case "completed":
      return "subscriptions.statusCompleted";
    default:
      return "subscriptions.statusActive";
  }
}

/**
 * The Overview's subscription section. It loads on its own, so a failure here cannot affect the rest of the Overview, and
 * a failed refresh shows an error rather than the previous period's or week's numbers.
 */
export function SubscriptionOverviewCard({ rangeStart, rangeEnd, anchorDate }: Props) {
  const { t, language, isRTL } = useI18n();
  const flip = rowFlipFor(isRTL);
  const [weekStart, setWeekStart] = useState(() => weekBoundsSunday(anchorDate).start);
  const [stats, setStats] = useState<SubscriptionOverviewStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [week, setWeek] = useState<SubscriptionWeekUtilization | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [weekError, setWeekError] = useState(false);
  const [correctionsOpen, setCorrectionsOpen] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [showList, setShowList] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [rows, setRows] = useState<SubscriptionOverviewBreakdownRow[] | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(false);
  const statsSeq = useRef(0);
  const weekSeq = useRef(0);

  useEffect(() => {
    setWeekStart(weekBoundsSunday(anchorDate).start);
  }, [anchorDate]);

  const loadStats = useCallback(async () => {
    const seq = ++statsSeq.current;
    try {
      const res = await rpcManagerSubscriptionOverviewStats(supabase, rangeStart, rangeEnd);
      if (seq !== statsSeq.current) return;
      if (res.ok) {
        setStats(res);
        setStatsError(false);
      } else {
        setStats(null);
        setStatsError(true);
      }
    } catch {
      if (seq !== statsSeq.current) return;
      setStats(null);
      setStatsError(true);
    }
  }, [rangeStart, rangeEnd]);

  const loadWeek = useCallback(async () => {
    const seq = ++weekSeq.current;
    setWeekLoading(true);
    setWeekError(false);
    try {
      const res = await rpcManagerSubscriptionWeekUtilization(supabase, weekStart);
      if (seq !== weekSeq.current) return;
      if (res.ok) {
        setWeek(res);
      } else {
        setWeek(null);
        setWeekError(true);
      }
    } catch {
      if (seq !== weekSeq.current) return;
      setWeek(null);
      setWeekError(true);
    } finally {
      if (seq === weekSeq.current) setWeekLoading(false);
    }
  }, [weekStart]);

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    setRowsError(false);
    try {
      const res = await rpcManagerSubscriptionOverviewBreakdown(supabase);
      if (Array.isArray(res)) {
        setRows(res);
      } else {
        setRows(null);
        setRowsError(true);
      }
    } catch {
      setRows(null);
      setRowsError(true);
    } finally {
      setRowsLoading(false);
    }
  }, []);

  useEffect(() => {
    setStats(null);
    setStatsError(false);
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    setWeek(null);
    void loadWeek();
  }, [loadWeek]);

  // Coming back from a subscription, a session or a payment must never show numbers from before it.
  useFocusEffect(
    useCallback(() => {
      void loadStats();
      void loadWeek();
      if (showList) void loadRows();
    }, [loadStats, loadWeek, loadRows, showList])
  );

  const toggleList = () => {
    const next = !showList;
    setShowList(next);
    if (next && rows === null) void loadRows();
  };

  const vm = useMemo(() => (week ? buildUtilizationViewModel(week) : null), [week]);
  const attention = useMemo(
    () =>
      stats
        ? buildOverviewAttention({
            overAllocated: week?.over_allocated ?? 0,
            openBalanceCount: stats.open_balance_count,
            openBalanceIls: stats.open_balance_ils,
            chargesNext7Count: stats.charges_next_7d_count,
            chargesNext7Ils: stats.charges_next_7d_ils,
            endingNext14Count: stats.ending_next_14d_count,
            pendingCorrections: stats.pending_corrections_count,
          })
        : [],
    [stats, week?.over_allocated]
  );

  const usageBySubscriptionPayee = useMemo(() => {
    const map = new Map<string, { occupied: number; available: number }>();
    for (const r of week?.rows ?? []) {
      const cur = map.get(r.payee_id) ?? { occupied: 0, available: 0 };
      map.set(r.payee_id, { occupied: cur.occupied + r.occupied, available: cur.available + r.available });
    }
    return map;
  }, [week]);

  const visibleRows = useMemo(() => {
    const list = rows ?? [];
    if (filter === "open") return list.filter((r) => r.outstanding_ils > 0.005);
    if (filter === "frozen") return list.filter((r) => r.display_status === "frozen" && !r.is_deleted);
    return list;
  }, [rows, filter]);

  const weekLabel = t("athleteSubscription.weekRange")
    .replace("{from}", formatISODateDayMonth(weekStart, language))
    .replace("{to}", formatISODateDayMonth(weekBoundsSunday(weekStart).end, language));

  const detailParts: string[] = [];
  if (week?.attended) detailParts.push(pluralKey(t, "subscriptions.overview.detailAttended", week.attended).replace("{n}", String(week.attended)));
  if (week?.penalty) detailParts.push(pluralKey(t, "subscriptions.overview.detailPenalty", week.penalty).replace("{n}", String(week.penalty)));
  if (week?.released) detailParts.push(pluralKey(t, "subscriptions.overview.detailReleased", week.released).replace("{n}", String(week.released)));

  return (
    <View style={styles.card}>
      <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
        {t("dashboard.financeSubscriptionsTitle")}
      </Text>

      {statsError ? (
        <RetryLine message={t("subscriptions.overview.loadError")} onRetry={() => void loadStats()} retryLabel={t("subscriptions.retry")} isRTL={isRTL} />
      ) : stats ? (
        <View style={[styles.chips, flip && styles.rowRtl]}>
          <View style={[styles.chip, styles.chipOn]}>
            <Text style={[styles.chipText, styles.chipTextOn]}>{pluralKey(t, "subscriptions.overview.chipActive", stats.running_count).replace("{n}", String(stats.running_count))}</Text>
          </View>
          {stats.frozen_count > 0 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{pluralKey(t, "subscriptions.overview.chipFrozen", stats.frozen_count).replace("{n}", String(stats.frozen_count))}</Text>
            </View>
          ) : null}
          {stats.scheduled_count > 0 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{pluralKey(t, "subscriptions.overview.chipScheduled", stats.scheduled_count).replace("{n}", String(stats.scheduled_count))}</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <ActivityIndicator color={theme.colors.textMuted} style={styles.spinner} />
      )}

      <View style={styles.panel}>
        <View style={[styles.weekHead, flip && styles.rowRtl]}>
          <Text style={[styles.panelTitle, isRTL && styles.rtl]}>{t("subscriptions.overview.allowanceTitle")}</Text>
          <View style={[styles.weekNav, flip && styles.rowRtl]}>
            <Pressable
              onPress={() => setWeekStart((w) => addStudioWeeksIso(w, -1))}
              style={styles.weekBtn}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.a11yPrevWeek")}
            >
              <Text style={styles.chevron}>{isRTL ? "→" : "←"}</Text>
            </Pressable>
            <Text style={styles.weekLabel} numberOfLines={1}>
              {weekLabel}
            </Text>
            <Pressable
              onPress={() => setWeekStart((w) => addStudioWeeksIso(w, 1))}
              style={styles.weekBtn}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.a11yNextWeek")}
            >
              <Text style={styles.chevron}>{isRTL ? "←" : "→"}</Text>
            </Pressable>
          </View>
        </View>

        {weekLoading && !week ? (
          <ActivityIndicator color={theme.colors.textMuted} style={styles.spinner} />
        ) : weekError || !week || !vm ? (
          <RetryLine message={t("subscriptions.overview.loadError")} onRetry={() => void loadWeek()} retryLabel={t("subscriptions.retry")} isRTL={isRTL} />
        ) : vm.empty ? (
          <Text style={[styles.muted, isRTL && styles.rtl]}>{t("subscriptions.overview.emptyWeek")}</Text>
        ) : (
          <>
            <View style={[styles.headlineRow, flip && styles.rowRtl]}>
              <Text style={styles.headline} accessibilityLabel={`${vm.occupied} / ${vm.available}`}>
                {"⁦"}
                {vm.occupied} / {vm.available}
                {"⁩"}
              </Text>
              <Text style={[styles.headlinePct, isRTL && styles.rtl]}>
                {t(vm.headlineKey).replace("{pct}", String(vm.occupiedPct)).replace("{used}", String(vm.usedPct))}
              </Text>
            </View>

            <View
              style={[styles.bar, flip && styles.rowRtl]}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: Math.max(vm.available, vm.occupied), now: vm.occupied }}
            >
              <View style={[styles.barPart, { width: `${vm.bar.used}%`, backgroundColor: LEGEND_COLOR.used }]} />
              <View style={[styles.barPart, { width: `${vm.bar.unmarked}%`, backgroundColor: LEGEND_COLOR.unmarked }]} />
              <View style={[styles.barPart, { width: `${vm.bar.reserved}%`, backgroundColor: LEGEND_COLOR.reserved }]} />
            </View>

            <View style={[styles.legend, flip && styles.rowRtl]}>
              {vm.legend.map((l) => (
                <View key={l.key} style={[styles.legendItem, vm.legend.length > 3 && styles.legendItemHalf]}>
                  <View style={[styles.legendHead, flip && styles.rowRtl]}>
                    <View style={[styles.dot, { backgroundColor: LEGEND_COLOR[l.key] }]} />
                    <Text style={[styles.legendLabel, isRTL && styles.rtl]} numberOfLines={2}>
                      {t(`subscriptions.overview.legend.${l.key}`)}
                    </Text>
                  </View>
                  <Text style={[styles.legendValue, isRTL && styles.rtl]}>{l.value}</Text>
                </View>
              ))}
            </View>

            {detailParts.length > 0 ? <Text style={[styles.detail, isRTL && styles.rtl]}>{detailParts.join(" · ")}</Text> : null}
            {week.extra_regular_price > 0 ? (
              <View style={styles.extraBox}>
                <Text style={[styles.extraText, isRTL && styles.rtl]}>
                  {pluralKey(t, "subscriptions.overview.extra", week.extra_regular_price).replace("{n}", String(week.extra_regular_price))}
                </Text>
              </View>
            ) : null}

            <Pressable onPress={() => setShowHow((v) => !v)} style={styles.howBtn} accessibilityRole="button" accessibilityState={{ expanded: showHow }}>
              <Text style={[styles.howBtnText, isRTL && styles.rtl]}>{t("subscriptions.overview.howCalculated")}</Text>
            </Pressable>
            {showHow ? <Text style={[styles.detail, isRTL && styles.rtl]}>{t("subscriptions.overview.howCalculatedBody")}</Text> : null}
          </>
        )}
      </View>

      {attention.length > 0 ? (
        <View style={styles.block}>
          <Text style={[styles.panelTitle, isRTL && styles.rtl]}>{t("subscriptions.overview.attention")}</Text>
          {attention.map((a) => {
            const body = (
              <>
                <Text style={[styles.attentionTitle, isRTL && styles.rtl]}>
                  {pluralKey(t, `subscriptions.overview.attention.${a.key}`, a.count).replace("{n}", String(a.count))}
                </Text>
                {a.amountIls != null ? <Text style={[styles.attentionSub, isRTL && styles.rtl]}>{displayMoney(a.amountIls)}</Text> : null}
              </>
            );
            return a.key === "pendingCorrections" ? (
              <Pressable
                key={a.key}
                onPress={() => setCorrectionsOpen(true)}
                style={({ pressed }) => [styles.attentionRow, styles.attentionRowAlert, pressed && styles.pressed]}
                accessibilityRole="button"
              >
                {body}
              </Pressable>
            ) : (
              <View key={a.key} style={[styles.attentionRow, a.key === "overAllocated" && styles.attentionRowAlert]}>
                {body}
              </View>
            );
          })}
        </View>
      ) : null}

      {stats ? (
        <View style={styles.block}>
          <Text style={[styles.panelTitle, isRTL && styles.rtl]}>{t("subscriptions.overview.moneyTitle")}</Text>
          <View style={[styles.moneyGrid, flip && styles.rowRtl]}>
            <View style={styles.moneyCell}>
              <Text style={[styles.moneyLbl, isRTL && styles.rtl]}>{t("subscriptions.overview.charged")}</Text>
              <Text style={[styles.moneyVal, isRTL && styles.rtl]}>{displayMoney(stats.charges_total_ils)}</Text>
            </View>
            <View style={[styles.moneyCell, styles.moneyCellAccent]}>
              <Text style={[styles.moneyLbl, isRTL && styles.rtl]}>{t("subscriptions.overview.received")}</Text>
              <Text style={[styles.moneyVal, styles.moneyValAccent, isRTL && styles.rtl]}>{displayMoney(stats.payments_total_ils)}</Text>
            </View>
          </View>
          <View style={[styles.banner, stats.open_balance_ils > 0 ? styles.bannerOwe : styles.bannerOk]}>
            <Text style={[styles.bannerLbl, isRTL && styles.rtl]}>{t("subscriptions.overview.openBalance")}</Text>
            <Text style={[styles.bannerVal, isRTL && styles.rtl]}>{displayMoney(stats.open_balance_ils)}</Text>
            {stats.credit_ils > 0 ? (
              <Text style={[styles.bannerHint, isRTL && styles.rtl]}>
                {t("subscriptions.overview.credit").replace("{amount}", displayMoney(stats.credit_ils))}
              </Text>
            ) : null}
            <Text style={[styles.bannerHint, isRTL && styles.rtl]}>{t("subscriptions.overview.openBalanceHint")}</Text>
          </View>
        </View>
      ) : null}

      <Pressable onPress={toggleList} style={({ pressed }) => [styles.ghost, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ expanded: showList }}>
        <Text style={[styles.ghostText, isRTL && styles.rtl]}>
          {showList ? t("dashboard.financeSubscriptionsHideBalances") : t("dashboard.financeSubscriptionsShowBalances")}
        </Text>
      </Pressable>

      <AnimatedOptionExpand open={showList}>
        <View style={styles.list}>
          {rowsLoading && !rows ? (
            <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.financeSubscriptionsLoading")}</Text>
          ) : rowsError ? (
            <RetryLine message={t("subscriptions.overview.loadError")} onRetry={() => void loadRows()} retryLabel={t("subscriptions.retry")} isRTL={isRTL} />
          ) : (rows ?? []).length === 0 ? (
            <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.financeSubscriptionsNoRows")}</Text>
          ) : (
            <>
              <View style={[styles.chips, flip && styles.rowRtl]}>
                {(["all", "open", "frozen"] as Filter[]).map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => setFilter(f)}
                    style={[styles.filter, filter === f && styles.filterOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filter === f }}
                  >
                    <Text style={[styles.filterText, filter === f && styles.filterTextOn]}>{t(`subscriptions.overview.filter.${f}`)}</Text>
                  </Pressable>
                ))}
              </View>
              {visibleRows.length === 0 ? (
                <Text style={[styles.muted, isRTL && styles.rtl]}>{t("subscriptions.overview.filterEmpty")}</Text>
              ) : (
                visibleRows.map((row) => {
                  const u = usageBySubscriptionPayee.get(row.payee_id);
                  const running = !row.is_deleted && row.display_status !== "stopped" && row.display_status !== "completed";
                  const next = !running
                    ? null
                    : row.display_status === "scheduled" && row.next_billing_date
                      ? t("subscriptions.overview.firstCharge").replace("{date}", formatISODateDayMonth(row.next_billing_date, language))
                      : row.next_billing_date
                        ? t("subscriptions.overview.nextCharge").replace("{date}", formatISODateDayMonth(row.next_billing_date, language))
                        : null;
                  return (
                    <Pressable
                      key={row.subscription_id}
                      onPress={() => router.push(`/(app)/manager/subscriptions/${row.subscription_id}` as Href)}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                      accessibilityRole="button"
                    >
                      <View style={[styles.rowTop, flip && styles.rowRtl]}>
                        <Text style={[styles.rowName, isRTL && styles.rtl]} numberOfLines={1}>
                          {row.payee_display_name}
                        </Text>
                        <Text style={styles.rowStatus}>{row.is_deleted ? t("subscriptions.statusDeleted") : t(statusLabelKey(row.display_status))}</Text>
                      </View>
                      <View style={[styles.rowTop, flip && styles.rowRtl]}>
                        <Text style={[styles.rowMeta, isRTL && styles.rtl]}>
                          {running && u ? t("subscriptions.overview.rowUsage").replace("{used}", String(u.occupied)).replace("{limit}", String(u.available)) : " "}
                        </Text>
                        <Text style={[styles.rowBalance, row.outstanding_ils > 0.005 ? styles.rowBalanceOwe : row.outstanding_ils < -0.005 ? styles.rowBalanceCredit : null]}>
                          {Math.abs(row.outstanding_ils) < 0.005
                            ? t("subscriptions.overview.settled")
                            : row.outstanding_ils > 0
                              ? displayMoney(row.outstanding_ils)
                              : t("subscriptions.overview.rowCredit").replace("{amount}", displayMoney(-row.outstanding_ils))}
                        </Text>
                      </View>
                      {next ? <Text style={[styles.rowMeta, isRTL && styles.rtl]}>{next}</Text> : null}
                    </Pressable>
                  );
                })
              )}
            </>
          )}
        </View>
      </AnimatedOptionExpand>
      <SubscriptionCorrectionsModal visible={correctionsOpen} onClose={() => setCorrectionsOpen(false)} onChanged={() => void loadStats()} />
    </View>
  );
}

function RetryLine({ message, onRetry, retryLabel, isRTL }: { message: string; onRetry: () => void; retryLabel: string; isRTL: boolean }) {
  return (
    <View style={styles.retry} accessibilityRole="alert">
      <Text style={[styles.retryText, isRTL && styles.rtl]}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.retryBtn} accessibilityRole="button">
        <Text style={styles.ghostText}>{retryLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  title: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  rowRtl: { flexDirection: "row-reverse" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: theme.radius.full, backgroundColor: theme.colors.surfaceElevated },
  chipOn: { backgroundColor: theme.colors.successBg },
  chipText: { fontSize: 12, fontWeight: "700", color: theme.colors.alertSubject },
  chipTextOn: { color: theme.colors.success },
  spinner: { paddingVertical: theme.spacing.sm },
  panel: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    gap: 12,
  },
  panelTitle: { fontSize: 13, fontWeight: "800", color: theme.colors.alertSubject, flexShrink: 1 },
  weekHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 4 },
  weekNav: { flexDirection: "row", alignItems: "center" },
  weekBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  chevron: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  weekLabel: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  headlineRow: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 10 },
  headline: { fontSize: 34, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  headlinePct: { fontSize: 14, fontWeight: "700", color: theme.colors.alertSubject, flexShrink: 1 },
  bar: { flexDirection: "row", height: 12, borderRadius: theme.radius.full, overflow: "hidden", backgroundColor: theme.colors.borderInput, gap: 2 },
  barPart: { height: "100%" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  legendItem: { flexGrow: 1, flexBasis: 72, gap: 2 },
  legendItemHalf: { flexBasis: "40%" },
  legendHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, fontWeight: "700", color: theme.colors.textMuted, flexShrink: 1 },
  legendValue: { fontSize: 18, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  detail: { fontSize: 12, lineHeight: 18, color: theme.colors.textMuted },
  extraBox: { padding: 10, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderInput, borderStyle: "dashed", backgroundColor: theme.colors.surface },
  extraText: { fontSize: 12, lineHeight: 17, color: theme.colors.alertSubject },
  howBtn: { minHeight: 44, justifyContent: "center" },
  howBtnText: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, textDecorationLine: "underline" },
  muted: { fontSize: 13, color: theme.colors.textMuted },
  block: { gap: 8 },
  attentionRow: { minHeight: 48, justifyContent: "center", paddingVertical: 8, paddingHorizontal: 12, gap: 2, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceElevated },
  attentionRowAlert: { backgroundColor: theme.colors.errorBg, borderColor: theme.colors.errorBorder },
  attentionTitle: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  attentionSub: { fontSize: 12, color: theme.colors.textMuted },
  moneyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  moneyCell: { flexGrow: 1, flexBasis: 130, padding: 12, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.border },
  moneyCellAccent: { borderColor: theme.colors.success },
  moneyLbl: { fontSize: 11, fontWeight: "700", color: theme.colors.textSoft, marginBottom: 4 },
  moneyVal: { fontSize: 16, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  moneyValAccent: { color: theme.colors.success },
  banner: { padding: 14, borderRadius: theme.radius.lg, borderWidth: 1, gap: 4 },
  bannerOwe: { backgroundColor: theme.colors.errorBg, borderColor: theme.colors.errorBorder },
  bannerOk: { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.border },
  bannerLbl: { fontSize: 12, fontWeight: "800", color: theme.colors.alertSubject },
  bannerVal: { ...theme.typography.display, color: theme.colors.text, fontVariant: ["tabular-nums"] },
  bannerHint: { fontSize: 12, lineHeight: 17, color: theme.colors.alertSubject },
  ghost: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: theme.radius.full, backgroundColor: theme.colors.backgroundAlt, borderWidth: 1, borderColor: theme.colors.border },
  ghostText: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  pressed: { opacity: 0.85 },
  list: { gap: 8 },
  filter: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: theme.radius.full, backgroundColor: theme.colors.backgroundAlt, borderWidth: 1, borderColor: theme.colors.borderInput },
  filterOn: { backgroundColor: theme.colors.cta },
  filterText: { fontSize: 12, fontWeight: "700", color: theme.colors.text },
  filterTextOn: { color: theme.colors.ctaText },
  row: { padding: 12, gap: 6, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceElevated },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowName: { fontSize: 14, fontWeight: "700", color: theme.colors.text, flexShrink: 1 },
  rowStatus: { fontSize: 11, fontWeight: "700", color: theme.colors.alertSubject },
  rowMeta: { fontSize: 12, color: theme.colors.textMuted, flexShrink: 1 },
  rowBalance: { fontSize: 13, fontWeight: "700", color: theme.colors.textSoft, fontVariant: ["tabular-nums"] },
  rowBalanceOwe: { color: theme.colors.text },
  rowBalanceCredit: { color: theme.colors.success },
  retry: { gap: 8 },
  retryText: { fontSize: 13, color: theme.colors.alertSubject },
  retryBtn: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: theme.radius.full, borderWidth: 1, borderColor: theme.colors.border },
});
