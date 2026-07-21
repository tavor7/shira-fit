import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, Platform, RefreshControl } from "react-native";
import { router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { formatISODateFull } from "../lib/dateFormat";
import { firstDayOfMonthISOLocal, lastDayOfMonthISOLocal, monthRangeISO, parseISODateLocal, shiftMonthAnchorISOLocal, toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { AppText } from "../components/AppText";
import { ActionButton } from "../components/ActionButton";
import { Skeleton } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { AddAccountPaymentModal } from "../components/AddAccountPaymentModal";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { normalizePaymentMethodKey, paymentMethodDashboardLabel } from "../lib/paymentMethod";
import {
  financeNoSessionsKey,
  noSessionsKey,
  overviewTitleKey,
  sectionEyebrowKey,
  GLOBAL_OVERVIEW_START_ISO,
  type ManagerPeriodMode,
} from "../lib/managerPeriodMode";
import {
  parseCapacityMismatch,
  parseFinance,
  parseMissingAttendance,
  type WeeklyFinanceAthlete,
  type WeeklyFinanceFamily,
} from "../lib/managerWeeklyStats";
import { fetchActiveAccountCounts, type ActiveAccountCounts } from "../lib/activeAccountCounts";
import { useCountUp } from "../hooks/useCountUp";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { AnimatedOptionExpand } from "../components/AnimatedOptionExpand";
import { AnimatedChevron } from "../components/AnimatedChevron";
import { CrossfadeSwap } from "../components/CrossfadeSwap";

type PeriodMode = ManagerPeriodMode;

/** Local-calendar Sunday (matches server `public._week_start_sunday`). */
function startOfWeekSunday(d: Date): string {
  const cal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  cal.setDate(cal.getDate() - cal.getDay());
  return toISODateLocal(cal);
}

/** Inclusive Sunday–Saturday range for the week containing `anchor` (ISO date). */
function weekRangeFromAnchor(anchor: string): { start: string; end: string } {
  const start = startOfWeekSunday(parseISODateLocal(anchor) ?? new Date());
  const endCal = parseISODateLocal(start) ?? new Date();
  endCal.setDate(endCal.getDate() + 6);
  return { start, end: toISODateLocal(endCal) };
}

function periodRangeFromAnchor(anchor: string, mode: PeriodMode): { start: string; end: string } {
  if (mode === "month") {
    const r = monthRangeISO(anchor);
    if (r) return r;
    return { start: anchor, end: lastDayOfMonthISOLocal(anchor) };
  }
  return weekRangeFromAnchor(anchor);
}

type StatsPayload = {
  ok?: boolean;
  error?: string;
  period?: string;
  week_start?: string;
  week_end?: string;
  session_count?: number;
  utilization_avg_pct?: number;
  cancellations?: number;
  no_shows?: number;
  waitlist_count?: number;
  checked_in_count?: number;
  payments_by_method?: Record<string, number>;
  finance?: unknown;
  missing_attendance?: unknown;
};

function formatIls(n: number, language: string): string {
  const r = Math.round(n * 100) / 100;
  return language === "he" ? `${r.toLocaleString("he-IL")} ₪` : `${r.toLocaleString("en-US")} ₪`;
}

function formatSessionTimeShort(isoTime: string): string {
  const s = String(isoTime ?? "").trim();
  return s.length >= 5 ? s.slice(0, 5) : s;
}

/** PostgREST when RPC signature is missing (DB not migrated yet). */
function isMissingRpcSignature(err: { message?: string } | null | undefined): boolean {
  const m = String(err?.message ?? "").toLowerCase();
  return (
    m.includes("could not find the function") ||
    m.includes("schema cache") ||
    m.includes("does not exist") ||
    m.includes("pgrst202")
  );
}

export default function ManagerDashboardScreen() {
  const { language, isRTL, t } = useI18n();
  const pct = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const [anchorDate, setAnchorDate] = useState(() => startOfWeekSunday(new Date()));
  const [periodMode, setPeriodMode] = useState<PeriodMode>("week");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<StatsPayload | null>(null);
  const [capacityMismatchCount, setCapacityMismatchCount] = useState(0);
  const [expandedCoachId, setExpandedCoachId] = useState<string | null>(null);
  const [showAthleteList, setShowAthleteList] = useState(false);
  const [addPayAthlete, setAddPayAthlete] = useState<WeeklyFinanceAthlete | null>(null);
  const [addPayFromFamily, setAddPayFromFamily] = useState(false);
  const [accountCounts, setAccountCounts] = useState<ActiveAccountCounts | null>(null);
  const [accountCountsLoading, setAccountCountsLoading] = useState(false);
  const loadSeqRef = useRef(0);

  const displayRange = useMemo(() => {
    if (periodMode === "global") {
      return {
        start: data?.week_start ?? GLOBAL_OVERVIEW_START_ISO,
        end: data?.week_end ?? toISODateLocal(new Date()),
      };
    }
    return periodRangeFromAnchor(anchorDate, periodMode);
  }, [anchorDate, periodMode, data?.week_start, data?.week_end]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const seq = ++loadSeqRef.current;
    if (!silent) setLoading(true);

    let raw: unknown = null;
    let error: { message: string } | null = null;

    const [primary, capacityRpc] = await Promise.all([
      supabase.rpc("manager_weekly_stats", {
        p_anchor: anchorDate,
        p_mode: periodMode,
      }),
      supabase.rpc("manager_capacity_mismatch", {
        p_anchor: anchorDate,
        p_mode: periodMode,
      }),
    ]);
    if (seq !== loadSeqRef.current) return;

    raw = primary.data;
    error = primary.error;

    if (!capacityRpc.error && capacityRpc.data && typeof capacityRpc.data === "object") {
      const capRaw = capacityRpc.data as Record<string, unknown>;
      if (capRaw.ok) {
        setCapacityMismatchCount(parseCapacityMismatch(capRaw).count);
      } else {
        setCapacityMismatchCount(0);
      }
    } else {
      setCapacityMismatchCount(0);
    }

    if (error && periodMode === "week" && isMissingRpcSignature(error)) {
      const legacy = await supabase.rpc("manager_weekly_stats", {
        p_week_start: anchorDate,
      });
      if (seq !== loadSeqRef.current) return;
      raw = legacy.data;
      error = legacy.error;
    }

    if (!silent) setLoading(false);

    if (error && (periodMode === "month" || periodMode === "global") && isMissingRpcSignature(primary.error)) {
      if (!silent) setData({ ok: false, error: t("dashboard.monthModeNeedsDb") });
      return;
    }

    if (error) {
      if (!silent) setData({ ok: false, error: error.message });
      return;
    }
    setData((raw as StatsPayload) ?? { ok: false });
  }, [anchorDate, periodMode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (periodMode !== "global") {
      setAccountCounts(null);
      setAccountCountsLoading(false);
      return;
    }
    let cancelled = false;
    setAccountCountsLoading(true);
    void (async () => {
      const counts = await fetchActiveAccountCounts();
      if (cancelled) return;
      setAccountCounts(counts);
      setAccountCountsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [periodMode]);

  function setWeekMode() {
    if (periodMode === "week") return;
    setPeriodMode("week");
    setAnchorDate((a) => startOfWeekSunday(parseISODateLocal(a) ?? new Date()));
    setExpandedCoachId(null);
  }

  function setMonthMode() {
    if (periodMode === "month") return;
    setPeriodMode("month");
    setAnchorDate((a) => firstDayOfMonthISOLocal(parseISODateLocal(a) ?? new Date()));
    setExpandedCoachId(null);
  }

  function setGlobalMode() {
    if (periodMode === "global") return;
    setPeriodMode("global");
    setExpandedCoachId(null);
  }

  const finance = useMemo(() => parseFinance(data?.finance), [data?.finance]);
  const missingAttendance = useMemo(
    () => parseMissingAttendance(data?.missing_attendance),
    [data?.missing_attendance]
  );

  function openFinanceBreakdown() {
    router.push({
      pathname: "/(app)/manager/finance-daily",
      params: { anchor: displayRange.start, periodMode },
    } as Href);
  }

  function openMissingAttendance() {
    router.push({
      pathname: "/(app)/manager/missing-attendance",
      params: { anchor: displayRange.start, periodMode },
    } as Href);
  }

  function openCapacityMismatch() {
    router.push({
      pathname: "/(app)/manager/capacity-mismatch",
      params: { anchor: displayRange.start, periodMode },
    } as Href);
  }

  function openWeeklyDetail(kind: string) {
    router.push({
      pathname: "/(app)/manager/weekly-detail",
      params: { weekStart: displayRange.start, weekEnd: displayRange.end, kind },
    } as Href);
  }

  const amountRows = useMemo(() => {
    const p = finance?.amounts_by_method ?? {};
    const merged = new Map<string, number>();
    for (const [k, v] of Object.entries(p)) {
      const canon = normalizePaymentMethodKey(k);
      if (!Number.isFinite(v)) continue;
      merged.set(canon, (merged.get(canon) ?? 0) + v);
    }
    return [...merged.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }, [finance?.amounts_by_method]);

  const coachPayoutTotal = useMemo(
    () => (finance?.coaches ?? []).reduce((s, c) => s + c.payout_ils, 0),
    [finance?.coaches]
  );
  const coachPayoutTotalDisplay = useCountUp(coachPayoutTotal);
  const outstandingBalanceDisplay = useCountUp(Math.abs(finance?.athlete_totals.outstanding_ils ?? 0));

  const avgFillDisplay = useCountUp(pct(data?.utilization_avg_pct));
  const cancellationsDisplay = useCountUp(data?.cancellations ?? 0);
  const noShowsDisplay = useCountUp(data?.no_shows ?? 0);
  const sessionCountDisplay = useCountUp(data?.session_count ?? 0);
  const waitlistCountDisplay = useCountUp(data?.waitlist_count ?? 0);
  const checkedInCountDisplay = useCountUp(data?.checked_in_count ?? 0);
  const missingAttendanceCountDisplay = useCountUp(missingAttendance.count);
  const capacityMismatchCountDisplay = useCountUp(capacityMismatchCount);

  const athleteListModel = useMemo(() => {
    if (!finance) return { families: [] as WeeklyFinanceFamily[], solo: [] as WeeklyFinanceAthlete[] };
    const inFamily = new Set<string>();
    for (const f of finance.families) {
      for (const m of f.members) {
        inFamily.add(`${m.kind}:${m.id}`);
      }
    }
    const solo = finance.athletes.filter((a) => !inFamily.has(`${a.kind}:${a.id}`));
    return { families: finance.families, solo };
  }, [finance]);

  function reportDateRangeFromOverview(): { start: string; end: string } {
    return { start: displayRange.start, end: displayRange.end };
  }

  function openAthleteHistory(a: WeeklyFinanceAthlete) {
    const params = new URLSearchParams();
    if (a.kind === "app") {
      params.set("presetUserId", a.id);
    } else {
      params.set("presetManualId", a.id);
    }
    const { start: ps, end: pe } = reportDateRangeFromOverview();
    params.set("presetStart", ps);
    params.set("presetEnd", pe);
    router.push(`/(app)/manager/participant-history?${params.toString()}` as Href);
  }

  function openFamilyHistory(family: WeeklyFinanceFamily) {
    const first = family.members.find((m) => m.kind === "app") ?? family.members[0];
    if (!first) return;
    openAthleteHistory(first);
  }

  function renderAthleteBalanceRow(a: WeeklyFinanceAthlete, opts?: { member?: boolean }) {
    const owe = a.outstanding_ils > 0.005;
    return (
      <View key={`${opts?.member ? "m:" : ""}${a.kind}-${a.id}`} style={[styles.athleteRow, opts?.member && styles.athleteRowMember]}>
        <Pressable
          onPress={() => openAthleteHistory(a)}
          style={({ pressed }) => [pressed && styles.athleteRowPressed]}
        >
          <View style={[styles.athleteRowTop, isRTL && styles.athleteRowTopRtl]}>
            <Text style={[styles.athleteName, isRTL && styles.rtl]} numberOfLines={1}>
              {a.name?.trim() || "—"}
              {a.kind === "manual" ? ` · ${t("dashboard.financeQuickAdd")}` : ""}
            </Text>
            <Text
              style={[
                styles.athleteBal,
                owe ? styles.athleteBalOwe : a.outstanding_ils < -0.005 ? styles.athleteBalAhead : styles.athleteBalOk,
                isRTL && styles.rtl,
              ]}
            >
              {formatIls(a.outstanding_ils, language)}
            </Text>
          </View>
          <Text style={[styles.athleteSub, isRTL && styles.rtl]} numberOfLines={2}>
            {t("dashboard.financeExpected")}: {formatIls(a.expected_ils, language)} · {t("dashboard.financeCollectedTotal")}:{" "}
            {formatIls(a.collected_total_ils, language)}
          </Text>
          <Text style={[styles.sessionTapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapActivityReport")}</Text>
        </Pressable>
        <Pressable
          onPress={() => openAddPayment(a, opts?.member === true)}
          style={({ pressed }) => [styles.athleteAddPayBtn, pressed && { opacity: 0.88 }]}
          accessibilityRole="button"
          accessibilityLabel={t("billing.addPayment")}
        >
          <Text style={styles.athleteAddPayBtnTxt}>{t("billing.addPayment")}</Text>
        </Pressable>
      </View>
    );
  }

  function openAddPayment(a: WeeklyFinanceAthlete, fromFamily = false) {
    setAddPayFromFamily(fromFamily);
    setAddPayAthlete(a);
  }

  const rangeLabelStart = displayRange.start;
  const rangeLabelEnd = displayRange.end;
  const isGlobal = periodMode === "global";
  const statsMatchPeriod =
    isGlobal ||
    (data?.week_start === displayRange.start && data?.week_end === displayRange.end);
  const showStats = !loading && data?.ok && statsMatchPeriod;
  const showMissingAttendanceTile = periodMode === "week" || missingAttendance.count > 0;
  const showAlertRow =
    periodMode === "week" || capacityMismatchCount > 0 || missingAttendance.count > 0;

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.cta} />}
    >
      <ManagerOverviewHubTabs />
      <View style={[styles.titleBlock, isRTL && styles.titleBlockRtl]}>
        <Text style={[styles.h, isRTL && styles.rtl]}>{t(overviewTitleKey(periodMode))}</Text>
        <View style={[styles.periodTrack, isRTL && styles.periodTrackRtl]}>
          <Pressable
            onPress={setWeekMode}
            style={({ pressed }) => [
              styles.periodChip,
              periodMode === "week" && styles.periodChipOn,
              pressed && periodMode !== "week" && styles.periodChipPressed,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: periodMode === "week" }}
          >
            <Text style={[styles.periodChipTxt, periodMode === "week" && styles.periodChipTxtOn]} numberOfLines={1}>
              {t("dashboard.periodWeek")}
            </Text>
          </Pressable>
          <Pressable
            onPress={setMonthMode}
            style={({ pressed }) => [
              styles.periodChip,
              periodMode === "month" && styles.periodChipOn,
              pressed && periodMode !== "month" && styles.periodChipPressed,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: periodMode === "month" }}
          >
            <Text style={[styles.periodChipTxt, periodMode === "month" && styles.periodChipTxtOn]} numberOfLines={1}>
              {t("dashboard.periodMonth")}
            </Text>
          </Pressable>
          <Pressable
            onPress={setGlobalMode}
            style={({ pressed }) => [
              styles.periodChip,
              periodMode === "global" && styles.periodChipOn,
              pressed && periodMode !== "global" && styles.periodChipPressed,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: periodMode === "global" }}
          >
            <Text style={[styles.periodChipTxt, periodMode === "global" && styles.periodChipTxtOn]} numberOfLines={1}>
              {t("dashboard.periodGlobal")}
            </Text>
          </Pressable>
        </View>
      </View>
      {isGlobal ? (
        <View style={styles.rangeRow}>
          <View style={styles.rangeCenter}>
            <Text style={[styles.rangeDates, isRTL && styles.rtl]} numberOfLines={2}>
              {t("dashboard.rangeAllTime")}
              {rangeLabelEnd ? (
                <>
                  {" · "}
                  {formatISODateFull(rangeLabelStart, language)}
                  <Text style={styles.rangeDash}>{" — "}</Text>
                  {formatISODateFull(rangeLabelEnd, language)}
                </>
              ) : null}
            </Text>
          </View>
        </View>
      ) : (
      <View style={[styles.rangeRow, isRTL && styles.rangeRowRtl]}>
        <Pressable
          style={({ pressed }) => [styles.rangeNavHit, pressed && styles.rangeNavPressed]}
          onPress={() =>
            setAnchorDate((a) =>
              periodMode === "week" ? shiftWeek(a, -7) : shiftMonthAnchorISOLocal(a, -1)
            )
          }
          accessibilityRole="button"
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityLabel={
            periodMode === "week" ? t("dashboard.a11yPrevWeek") : t("dashboard.a11yPrevMonth")
          }
        >
          <Text style={styles.rangeChevron}>{"‹"}</Text>
        </Pressable>
        <View style={styles.rangeCenter}>
          <Text style={[styles.rangeDates, isRTL && styles.rtl]} numberOfLines={2}>
            {formatISODateFull(rangeLabelStart, language)}
            <Text style={styles.rangeDash}>{" — "}</Text>
            {formatISODateFull(rangeLabelEnd, language)}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.rangeNavHit, pressed && styles.rangeNavPressed]}
          onPress={() =>
            setAnchorDate((a) =>
              periodMode === "week" ? shiftWeek(a, 7) : shiftMonthAnchorISOLocal(a, 1)
            )
          }
          accessibilityRole="button"
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityLabel={
            periodMode === "week" ? t("dashboard.a11yNextWeek") : t("dashboard.a11yNextMonth")
          }
        >
          <Text style={styles.rangeChevron}>{"›"}</Text>
        </Pressable>
      </View>
      )}

      <CrossfadeSwap
        loading={loading}
        skeleton={
          <View style={styles.statsGrid}>
            <View style={styles.statsPair}>
              <View style={styles.tile}>
                <Skeleton width={60} height={11} style={styles.tileSkeletonCenter} />
                <Skeleton width={40} height={22} style={styles.tileSkeletonValue} />
              </View>
              <View style={styles.tile}>
                <Skeleton width={60} height={11} style={styles.tileSkeletonCenter} />
                <Skeleton width={40} height={22} style={styles.tileSkeletonValue} />
              </View>
            </View>
            <View style={styles.statsPair}>
              <View style={styles.tile}>
                <Skeleton width={60} height={11} style={styles.tileSkeletonCenter} />
                <Skeleton width={40} height={22} style={styles.tileSkeletonValue} />
              </View>
              <View style={styles.tile}>
                <Skeleton width={60} height={11} style={styles.tileSkeletonCenter} />
                <Skeleton width={40} height={22} style={styles.tileSkeletonValue} />
              </View>
            </View>
          </View>
        }
      >
        {showStats ? (
          <FadeSlideIn key={periodMode}>
            <Text style={[styles.sectionEyebrow, isRTL && styles.rtl]}>{t(sectionEyebrowKey(periodMode))}</Text>
            <View style={styles.statsCard}>
              <View style={styles.statsGrid}>
                <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                  <Pressable
                    onPress={() => openWeeklyDetail("avg_fill")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11yAvgFill")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.tileAvgFill")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(avgFillDisplay)}%</AppText>
                  </Pressable>
                  <Pressable
                    onPress={() => openWeeklyDetail("cancellations")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11yCancellations")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.tileCancellations")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(cancellationsDisplay)}</AppText>
                  </Pressable>
                </View>
                <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                  <Pressable
                    onPress={() => openWeeklyDetail("no_shows")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11yNoShows")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.tileNoShows")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(noShowsDisplay)}</AppText>
                  </Pressable>
                  <Pressable
                    onPress={() => openWeeklyDetail("sessions")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11ySessions")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.tileSessions")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(sessionCountDisplay)}</AppText>
                  </Pressable>
                </View>
                <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                  <Pressable
                    onPress={() => openWeeklyDetail("waitlist")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11yWaitlist")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.waitlist")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(waitlistCountDisplay)}</AppText>
                  </Pressable>
                  <Pressable
                    onPress={() => openWeeklyDetail("checked_in")}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.a11yCheckedIn")}
                  >
                    <AppText variant="label" soft style={styles.tileL}>{t("dashboard.checkedIn")}</AppText>
                    <AppText variant="display" style={styles.tileV}>{Math.round(checkedInCountDisplay)}</AppText>
                  </Pressable>
                </View>
              </View>
            </View>
          </FadeSlideIn>
        ) : null}
      </CrossfadeSwap>

      {!loading && data && !data.ok ? (
        <View style={styles.errBlock}>
          <Text style={styles.err}>{data.error ?? t("common.error")}</Text>
          <ActionButton label={t("auth.retryConnection")} onPress={() => void load()} style={styles.errRetryBtn} />
        </View>
      ) : null}

      {showStats && (data.session_count ?? 0) === 0 ? (
        <Text style={[styles.emptyWeek, isRTL && styles.rtl]}>{t(noSessionsKey(periodMode))}</Text>
      ) : null}

      {showStats && showAlertRow ? (
        <View style={[styles.alertRow, isRTL && styles.alertRowRtl]}>
          {showMissingAttendanceTile ? (
            <Pressable
              onPress={missingAttendance.count > 0 ? openMissingAttendance : undefined}
              disabled={missingAttendance.count === 0}
              style={({ pressed }) => [
                styles.alertTile,
                styles.alertTileHalf,
                missingAttendance.count > 0 ? styles.alertTileActive : styles.alertTileOk,
                missingAttendance.count > 0 && pressed && styles.tilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.a11yMissingAttendance")}
              accessibilityState={{ disabled: missingAttendance.count === 0 }}
            >
              <Text style={styles.alertTileL}>{t("dashboard.missingAttendanceTile")}</Text>
              <Text style={styles.alertTileV}>{Math.round(missingAttendanceCountDisplay)}</Text>
              {missingAttendance.count > 0 ? (
                <Text style={styles.alertTileHint}>{t("dashboard.missingAttendanceTileHint")}</Text>
              ) : null}
            </Pressable>
          ) : null}
          <Pressable
            onPress={capacityMismatchCount > 0 ? openCapacityMismatch : undefined}
            disabled={capacityMismatchCount === 0}
            style={({ pressed }) => [
              styles.alertTile,
              periodMode === "week" ? styles.alertTileHalf : null,
              capacityMismatchCount > 0 ? styles.alertTileWarn : styles.alertTileOk,
              capacityMismatchCount > 0 && pressed && styles.tilePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("dashboard.a11yCapacityMismatch")}
            accessibilityState={{ disabled: capacityMismatchCount === 0 }}
          >
            <Text style={styles.alertTileL}>{t("dashboard.capacityMismatchTile")}</Text>
            <Text style={styles.alertTileV}>{Math.round(capacityMismatchCountDisplay)}</Text>
            {capacityMismatchCount > 0 ? (
              <Text style={styles.alertTileHintWarn}>{t("dashboard.capacityMismatchTileHint")}</Text>
            ) : null}
          </Pressable>
        </View>
      ) : null}

      {showStats && finance ? (
        <View style={styles.financeBlock}>
          <Text style={[styles.sectionEyebrow, styles.financeEyebrow, isRTL && styles.rtl]}>{t("dashboard.financeTitle")}</Text>

          <View style={styles.financeCard}>
            <Text style={[styles.financeCardTitle, isRTL && styles.rtl]}>{t("dashboard.financeCoachPayouts")}</Text>
            <Text style={[styles.financeHint, isRTL && styles.rtl]}>{t("dashboard.financeHintCoach")}</Text>
            <View style={[styles.moneyHero, isRTL && styles.moneyHeroRtl]}>
              <Text style={[styles.moneyHeroLbl, isRTL && styles.rtl]}>{t("dashboard.financeTotalToCoaches")}</Text>
              <Text style={[styles.moneyHeroVal, isRTL && styles.rtl]}>{formatIls(coachPayoutTotalDisplay, language)}</Text>
            </View>
            <Text style={[styles.tapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapCoachHint")}</Text>
            <View style={styles.coachList}>
              {finance.coaches.length === 0 ? (
                <Text style={[styles.muted, isRTL && styles.rtl]}>{t(financeNoSessionsKey(periodMode))}</Text>
              ) : (
                finance.coaches.map((c) => {
                  const open = expandedCoachId === c.coach_id;
                  return (
                    <View key={c.coach_id} style={styles.coachRowWrap}>
                      <Pressable
                        onPress={() => setExpandedCoachId(open ? null : c.coach_id)}
                        style={({ pressed }) => [styles.coachRow, pressed && styles.coachRowPressed]}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        accessibilityLabel={`${c.name?.trim() || "—"} · ${formatIls(c.payout_ils, language)}`}
                        accessibilityHint={open ? t("dashboard.a11yCoachCollapse") : t("dashboard.a11yCoachExpand")}
                      >
                        <View style={[styles.coachRowMain, isRTL && styles.coachRowMainRtl]}>
                          <Text style={[styles.coachName, isRTL && styles.rtl]} numberOfLines={1}>
                            {c.name?.trim() || "—"}
                          </Text>
                          {c.has_rate_gap ? (
                            <View style={styles.warnPill}>
                              <Text style={styles.warnPillTxt}>{t("dashboard.financeRateMissing")}</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={[styles.coachPayout, isRTL && styles.rtl]}>{formatIls(c.payout_ils, language)}</Text>
                        <AnimatedChevron open={open} style={styles.chev} />
                      </Pressable>
                      <AnimatedOptionExpand open={open}>
                        <View style={styles.sessionList}>
                          {c.sessions.map((s) => (
                            <Pressable
                              key={s.session_id}
                              onPress={() => router.push(`/(app)/manager/session/${s.session_id}` as Href)}
                              style={({ pressed }) => [styles.sessionLine, pressed && styles.sessionLinePressed]}
                              accessibilityRole="button"
                              accessibilityLabel={`${formatISODateFull(s.session_date, language)} ${formatSessionTimeShort(s.start_time)}`}
                            >
                              <View style={[styles.sessionLineTop, isRTL && styles.sessionLineTopRtl]}>
                                <Text style={[styles.sessionDate, isRTL && styles.rtl]} numberOfLines={1}>
                                  {formatISODateFull(s.session_date, language)} · {formatSessionTimeShort(s.start_time)}
                                </Text>
                                {s.rate_missing ? (
                                  <Text style={styles.sessionWarn}>{t("dashboard.financeRateMissing")}</Text>
                                ) : null}
                              </View>
                              <Text style={[styles.sessionMeta, isRTL && styles.rtl]} numberOfLines={2}>
                                {t("dashboard.financeTier")}: {s.tier_registered} · {t("dashboard.financeGroupCap")}: {s.group_capacity}
                                {s.rate_ils != null ? ` · ${formatIls(s.rate_ils, language)}` : ""}
                                {" → "}
                                {formatIls(s.payout_ils, language)}
                              </Text>
                              <Text style={[styles.sessionTapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapSession")}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </AnimatedOptionExpand>
                    </View>
                  );
                })
              )}
            </View>
          </View>

          <View style={styles.financeCard}>
            <Text style={[styles.financeCardTitle, isRTL && styles.rtl]}>{t("dashboard.financeAthleteRevenue")}</Text>
            <Text style={[styles.financeHint, isRTL && styles.rtl]}>{t("dashboard.financeHintAthlete")}</Text>

            <View style={styles.moneyGrid}>
              <Pressable
                onPress={openFinanceBreakdown}
                style={({ pressed }) => [styles.moneyCell, styles.moneyCellTappable, pressed && styles.moneyCellPressed]}
                accessibilityRole="button"
                accessibilityLabel={`${t("dashboard.financeExpected")}: ${formatIls(finance.athlete_totals.expected_ils, language)}`}
                accessibilityHint={t("dashboard.financeBreakdownA11yHint")}
              >
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeExpected")}</Text>
                <Text style={[styles.moneyCellVal, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.expected_ils, language)}
                </Text>
                <Text style={[styles.moneyCellTap, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownTap")}</Text>
              </Pressable>
              <Pressable
                onPress={openFinanceBreakdown}
                style={({ pressed }) => [styles.moneyCell, styles.moneyCellTappable, pressed && styles.moneyCellPressed]}
                accessibilityRole="button"
                accessibilityLabel={`${t("dashboard.financeCollectedSessions")}: ${formatIls(finance.athlete_totals.collected_sessions_ils, language)}`}
                accessibilityHint={t("dashboard.financeBreakdownA11yHint")}
              >
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeCollectedSessions")}</Text>
                <Text style={[styles.moneyCellVal, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.collected_sessions_ils, language)}
                </Text>
                <Text style={[styles.moneyCellTap, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownTap")}</Text>
              </Pressable>
              <Pressable
                onPress={openFinanceBreakdown}
                style={({ pressed }) => [
                  styles.moneyCell,
                  styles.moneyCellTappable,
                  styles.moneyCellAccentWrap,
                  pressed && styles.moneyCellPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${t("dashboard.financeCollectedTotal")}: ${formatIls(finance.athlete_totals.collected_total_ils, language)}`}
                accessibilityHint={t("dashboard.financeBreakdownA11yHint")}
              >
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeCollectedTotal")}</Text>
                <Text style={[styles.moneyCellVal, styles.moneyCellAccent, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.collected_total_ils, language)}
                </Text>
                <Text style={[styles.moneyCellTap, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownTap")}</Text>
              </Pressable>
            </View>

            <View
              style={[
                styles.balanceBanner,
                finance.athlete_totals.outstanding_ils > 0
                  ? styles.balanceBannerOwe
                  : finance.athlete_totals.outstanding_ils < 0
                    ? styles.balanceBannerAhead
                    : styles.balanceBannerOk,
              ]}
            >
              <Text style={[styles.balanceBannerLbl, isRTL && styles.rtl]}>
                {finance.athlete_totals.outstanding_ils >= 0 ? t("dashboard.financeOutstanding") : t("dashboard.financeAhead")}
              </Text>
              <Text style={[styles.balanceBannerVal, isRTL && styles.rtl]}>
                {formatIls(outstandingBalanceDisplay, language)}
              </Text>
            </View>

            {amountRows.length > 0 ? (
              <>
                <Text style={[styles.subhSm, styles.amountsHeading, isRTL && styles.rtl]}>{t("dashboard.financeAmountsByMethod")}</Text>
                <View style={[styles.payList, isRTL && styles.payListRtl]}>
                  {amountRows.map(([method, n]) => (
                    <View key={method} style={[styles.payRow, isRTL && styles.payRowRtl]}>
                      <StatusChip label={paymentMethodDashboardLabel(method, language)} tone="neutral" />
                      <Text style={styles.payAmt}>{formatIls(n, language)}</Text>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            <Pressable
              onPress={() => setShowAthleteList((v) => !v)}
              style={({ pressed }) => [styles.ghostBtn, styles.ghostBtnSpaced, pressed && styles.ghostBtnPressed]}
              accessibilityRole="button"
              accessibilityState={{ expanded: showAthleteList }}
            >
              <Text style={[styles.ghostBtnTxt, isRTL && styles.rtl]}>
                {showAthleteList ? t("dashboard.financeHideBalances") : t("dashboard.financeShowBalances")}
              </Text>
            </Pressable>

            <AnimatedOptionExpand open={showAthleteList}>
              <View style={styles.athleteList}>
                {athleteListModel.families.length === 0 && athleteListModel.solo.length === 0 ? (
                  <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.financeNoAthleteRows")}</Text>
                ) : (
                  <>
                    {athleteListModel.families.map((family) => {
                      const owe = family.outstanding_ils > 0.005;
                      const canTapFamily = family.members.length > 0;
                      return (
                        <View key={`family-${family.id}`} style={styles.familyGroup}>
                          <Pressable
                            onPress={() => canTapFamily && openFamilyHistory(family)}
                            disabled={!canTapFamily}
                            style={({ pressed }) => [
                              styles.familyRow,
                              canTapFamily && pressed && styles.athleteRowPressed,
                            ]}
                          >
                            <View style={[styles.athleteRowTop, isRTL && styles.athleteRowTopRtl]}>
                              <Text style={[styles.familyName, isRTL && styles.rtl]} numberOfLines={1}>
                                {family.name}
                              </Text>
                              <Text
                                style={[
                                  styles.athleteBal,
                                  owe ? styles.athleteBalOwe : family.outstanding_ils < -0.005 ? styles.athleteBalAhead : styles.athleteBalOk,
                                  isRTL && styles.rtl,
                                ]}
                              >
                                {formatIls(family.outstanding_ils, language)}
                              </Text>
                            </View>
                            <Text style={[styles.athleteSub, isRTL && styles.rtl]} numberOfLines={2}>
                              {t("dashboard.financeFamilySummary")
                                .replace("{n}", String(family.members.length))}{" "}
                              · {t("dashboard.financeExpected")}: {formatIls(family.expected_ils, language)} ·{" "}
                              {t("dashboard.financeCollectedTotal")}: {formatIls(family.collected_total_ils, language)}
                            </Text>
                            {canTapFamily ? (
                              <Text style={[styles.sessionTapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapActivityReport")}</Text>
                            ) : null}
                          </Pressable>
                          {family.members.map((m) => renderAthleteBalanceRow(m, { member: true }))}
                        </View>
                      );
                    })}
                    {athleteListModel.solo.map((a) => renderAthleteBalanceRow(a))}
                  </>
                )}
              </View>
            </AnimatedOptionExpand>
          </View>
        </View>
      ) : null}

      {isGlobal ? (
        <View style={styles.accountsSummary}>
          <Text style={[styles.accountsSummaryEyebrow, isRTL && styles.rtl]}>{t("dashboard.globalAccountsEyebrow")}</Text>
          <CrossfadeSwap
            loading={accountCountsLoading}
            skeleton={<ActivityIndicator color={theme.colors.textSoft} size="small" />}
          >
            {accountCounts ? (
              <>
                <Text style={[styles.accountsSummaryLine, isRTL && styles.rtl]}>
                  {t("dashboard.globalAccountsSummary")
                    .replace("{total}", String(accountCounts.total))
                    .replace("{app}", String(accountCounts.appAthletes))
                    .replace("{quick}", String(accountCounts.quickAddOnly))}
                </Text>
                <Text style={[styles.accountsSummaryHint, isRTL && styles.rtl]}>{t("dashboard.globalAccountsHint")}</Text>
              </>
            ) : (
              <Text style={[styles.accountsSummaryHint, isRTL && styles.rtl]}>{t("common.error")}</Text>
            )}
          </CrossfadeSwap>
        </View>
      ) : null}

      <AddAccountPaymentModal
        visible={addPayAthlete != null}
        onClose={() => {
          setAddPayAthlete(null);
          setAddPayFromFamily(false);
        }}
        payeeId={addPayAthlete?.id ?? ""}
        payeeIsManual={addPayAthlete?.kind === "manual"}
        payeeLabel={addPayAthlete?.name?.trim() || undefined}
        showPayerName={addPayFromFamily}
        onSaved={() => load({ silent: true })}
      />
    </ScrollView>
  );
}

function shiftWeek(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return startOfWeekSunday(d);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: 48 },
  titleBlock: { marginBottom: theme.spacing.sm },
  titleBlockRtl: { alignItems: "flex-end" },
  h: { fontSize: 22, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.sm, letterSpacing: -0.35 },
  periodTrack: {
    flexDirection: "row",
    gap: 8,
    padding: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignSelf: "stretch",
  },
  periodTrackRtl: { flexDirection: "row-reverse" },
  periodChip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minWidth: 0,
  },
  periodChipOn: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  periodChipPressed: { opacity: 0.92 },
  periodChipTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted, letterSpacing: 0.2 },
  periodChipTxtOn: { color: theme.colors.ctaText },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  sectionEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 8,
    marginTop: 2,
  },
  financeEyebrow: { marginTop: theme.spacing.md, marginBottom: 10 },
  rangeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  rangeRowRtl: { flexDirection: "row-reverse" },
  rangeNavHit: {
    minWidth: 40,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  rangeNavPressed: { opacity: 0.45 },
  rangeChevron: {
    fontSize: 26,
    fontWeight: "200",
    color: theme.colors.textMuted,
    lineHeight: 28,
    marginTop: -2,
  },
  rangeCenter: { flex: 1, paddingHorizontal: theme.spacing.sm },
  rangeDates: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.text,
    letterSpacing: -0.15,
    lineHeight: 20,
  },
  rangeDash: {
    fontWeight: "600",
    color: theme.colors.textSoft,
  },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 8 },
  errBlock: { alignItems: "flex-start" },
  errRetryBtn: { marginTop: theme.spacing.sm },
  statsCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  statsGrid: { gap: 8 },
  statsPair: { flexDirection: "row", gap: 8 },
  statsPairRtl: { flexDirection: "row-reverse" },
  tile: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tileL: {
    textTransform: "uppercase",
    textAlign: "center",
  },
  tileV: {
    marginTop: theme.spacing.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
  tileSkeletonCenter: { alignSelf: "center" },
  tileSkeletonValue: { alignSelf: "center", marginTop: theme.spacing.sm },
  tilePressed: { opacity: Platform.OS === "web" ? 0.92 : 0.9 },
  financeBlock: { marginTop: theme.spacing.lg, gap: theme.spacing.sm + 2 },
  financeCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  financeCardTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.text, marginBottom: 6, letterSpacing: -0.2 },
  financeHint: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 18, marginBottom: theme.spacing.sm },
  moneyHero: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 10,
  },
  moneyHeroRtl: { flexDirection: "row-reverse" },
  moneyHeroLbl: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  moneyHeroVal: { fontSize: 20, fontWeight: "900", color: theme.colors.cta, fontVariant: ["tabular-nums"] },
  ghostBtn: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  ghostBtnPressed: { opacity: 0.9 },
  ghostBtnSpaced: { marginTop: theme.spacing.sm },
  ghostBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  tapHint: { fontSize: 11, fontWeight: "600", color: theme.colors.textSoft, marginBottom: 8, lineHeight: 16 },
  amountsHeading: { marginTop: theme.spacing.md, marginBottom: 4 },
  coachList: { marginTop: 6, gap: 8 },
  coachRowWrap: { borderRadius: theme.radius.md, overflow: "hidden" },
  coachRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
  },
  coachRowPressed: { opacity: 0.92 },
  coachRowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  coachRowMainRtl: { flexDirection: "row-reverse" },
  coachName: { flex: 1, fontSize: 14, fontWeight: "800", color: theme.colors.text },
  warnPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
  },
  warnPillTxt: { fontSize: 10, fontWeight: "800", color: theme.colors.error },
  coachPayout: { fontSize: 15, fontWeight: "900", color: theme.colors.cta, fontVariant: ["tabular-nums"] },
  chev: { fontSize: 12, color: theme.colors.textSoft, width: 16, textAlign: "center" },
  sessionList: {
    marginTop: 8,
    gap: 8,
  },
  sessionLine: {
    padding: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  sessionLinePressed: { opacity: 0.92 },
  sessionLineTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  sessionLineTopRtl: { flexDirection: "row-reverse" },
  sessionDate: { flex: 1, fontSize: 12, fontWeight: "800", color: theme.colors.text },
  sessionWarn: { fontSize: 10, fontWeight: "800", color: theme.colors.error },
  sessionMeta: { marginTop: 4, fontSize: 11, color: theme.colors.textMuted, lineHeight: 16 },
  sessionTapHint: { marginTop: 6, fontSize: 10, fontWeight: "700", color: theme.colors.textSoft },
  moneyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  moneyCell: {
    width: "48%",
    flexGrow: 1,
    minWidth: 140,
    padding: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  moneyCellLbl: { fontSize: 11, fontWeight: "700", color: theme.colors.textSoft, marginBottom: 6 },
  moneyCellVal: { fontSize: 16, fontWeight: "900", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  moneyCellAccent: { color: theme.colors.success },
  moneyCellTappable: { borderColor: theme.colors.borderInput },
  moneyCellAccentWrap: { borderColor: theme.colors.success },
  moneyCellPressed: { opacity: 0.9 },
  moneyCellTap: { marginTop: 6, fontSize: 10, fontWeight: "700", color: theme.colors.textSoft },
  balanceBanner: {
    marginTop: 12,
    padding: 14,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
  },
  balanceBannerOwe: { backgroundColor: theme.colors.errorBg, borderColor: theme.colors.errorBorder },
  balanceBannerAhead: { backgroundColor: theme.colors.successBg, borderColor: theme.colors.success },
  balanceBannerOk: { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.border },
  balanceBannerLbl: { fontSize: 12, fontWeight: "800", color: theme.colors.alertSubject },
  balanceBannerVal: { marginTop: 4, fontSize: 22, fontWeight: "900", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  subh: { fontWeight: "800", color: theme.colors.text, marginBottom: 6, fontSize: 15 },
  subhSm: { fontWeight: "800", color: theme.colors.text, fontSize: 13 },
  hintLine: { fontSize: 12, color: theme.colors.textMuted, marginBottom: 10, lineHeight: 17 },
  emptyWeek: { marginTop: 12, fontSize: 14, fontWeight: "700", color: theme.colors.textSoft },
  alertRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.md },
  alertRowRtl: { flexDirection: "row-reverse" },
  alertTile: {
    marginTop: 0,
    padding: theme.spacing.md,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    alignItems: "center",
  },
  alertTileHalf: { flex: 1, minWidth: 0 },
  alertTileActive: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  alertTileWarn: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderInput,
  },
  alertTileOk: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.borderMuted,
    opacity: 0.85,
  },
  alertTileL: {
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.textMuted,
    textAlign: "center",
    alignSelf: "stretch",
  },
  alertTileV: {
    marginTop: 6,
    fontSize: 28,
    fontWeight: "900",
    color: theme.colors.text,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
    alignSelf: "stretch",
  },
  alertTileHint: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.error,
    textAlign: "center",
    alignSelf: "stretch",
  },
  alertTileHintWarn: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.alertSubject,
    textAlign: "center",
    alignSelf: "stretch",
  },
  muted: { color: theme.colors.textSoft },
  paySectionCard: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  payList: { gap: 10 },
  payListRtl: { alignItems: "stretch" },
  payRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  payRowRtl: { flexDirection: "row-reverse" },
  payN: { fontSize: 16, fontWeight: "900", color: theme.colors.cta },
  payAmt: { fontSize: 14, fontWeight: "900", color: theme.colors.success, fontVariant: ["tabular-nums"] },
  athleteList: { marginTop: 10, gap: 8 },
  familyGroup: { gap: 6 },
  familyRow: {
    padding: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  familyName: { flex: 1, fontSize: 15, fontWeight: "900", color: theme.colors.text },
  athleteRowMember: { marginStart: theme.spacing.md },
  athleteRow: {
    padding: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  athleteRowPressed: { opacity: 0.9 },
  athleteRowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  athleteRowTopRtl: { flexDirection: "row-reverse" },
  athleteName: { flex: 1, fontSize: 14, fontWeight: "800", color: theme.colors.text },
  athleteBal: { fontSize: 14, fontWeight: "900", fontVariant: ["tabular-nums"] },
  athleteBalOwe: { color: theme.colors.error },
  athleteBalAhead: { color: theme.colors.success },
  athleteBalOk: { color: theme.colors.textMuted },
  athleteSub: { marginTop: 6, fontSize: 11, color: theme.colors.textMuted, lineHeight: 16 },
  athleteAddPayBtn: {
    marginTop: 10,
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  athleteAddPayBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 12 },
  accountsSummary: {
    marginTop: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    gap: 4,
  },
  accountsSummaryEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 1.1,
  },
  accountsSummaryLine: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textMuted,
    lineHeight: 20,
  },
  accountsSummaryHint: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 17,
  },
});
