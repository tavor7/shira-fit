import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, Platform } from "react-native";
import { router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { formatISODateFull } from "../lib/dateFormat";
import { firstDayOfMonthISOLocal, parseISODateLocal, shiftMonthAnchorISOLocal, toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { StatusChip } from "../components/StatusChip";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { normalizePaymentMethodKey, paymentMethodDashboardLabel } from "../lib/paymentMethod";

/** Local-calendar Sunday (matches server `public._week_start_sunday`). */
function startOfWeekSunday(d: Date): string {
  const cal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  cal.setDate(cal.getDate() - cal.getDay());
  return toISODateLocal(cal);
}

type PeriodMode = "week" | "month";

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
  finance?: WeeklyFinance;
};

type WeeklyFinanceCoachSession = {
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
  registered_count: number;
  group_capacity: number;
  tier_registered: number;
  rate_ils: number | null;
  payout_ils: number;
  rate_missing: boolean;
};

type WeeklyFinanceCoach = {
  coach_id: string;
  name: string | null;
  payout_ils: number;
  has_rate_gap: boolean;
  sessions: WeeklyFinanceCoachSession[];
};

type WeeklyFinanceAthleteTotals = {
  expected_ils: number;
  collected_sessions_ils: number;
  collected_account_ils: number;
  collected_total_ils: number;
  outstanding_ils: number;
};

type WeeklyFinanceAthlete = {
  kind: "app" | "manual";
  id: string;
  name: string | null;
  expected_ils: number;
  collected_sessions_ils: number;
  collected_account_ils: number;
  collected_total_ils: number;
  outstanding_ils: number;
};

type WeeklyFinance = {
  coaches: WeeklyFinanceCoach[];
  athlete_totals: WeeklyFinanceAthleteTotals;
  athletes: WeeklyFinanceAthlete[];
  amounts_by_method: Record<string, number>;
};

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

function parseFinance(raw: unknown): WeeklyFinance | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const coachesRaw = o.coaches;
  const coaches: WeeklyFinanceCoach[] = [];
  if (Array.isArray(coachesRaw)) {
    for (const c of coachesRaw) {
      if (!c || typeof c !== "object") continue;
      const r = c as Record<string, unknown>;
      const sid = String(r.coach_id ?? "");
      if (!sid) continue;
      const sessionsRaw = r.sessions;
      const sessions: WeeklyFinanceCoachSession[] = [];
      if (Array.isArray(sessionsRaw)) {
        for (const s of sessionsRaw) {
          if (!s || typeof s !== "object") continue;
          const x = s as Record<string, unknown>;
          const id = String(x.session_id ?? "");
          if (!id) continue;
          sessions.push({
            session_id: id,
            session_date: String(x.session_date ?? ""),
            start_time: String(x.start_time ?? ""),
            duration_minutes: num(x.duration_minutes, 60),
            registered_count: num(x.registered_count),
            group_capacity: num(x.group_capacity),
            tier_registered: num(x.tier_registered),
            rate_ils: x.rate_ils === null || x.rate_ils === undefined ? null : num(x.rate_ils),
            payout_ils: num(x.payout_ils),
            rate_missing: Boolean(x.rate_missing),
          });
        }
      }
      coaches.push({
        coach_id: sid,
        name: r.name == null ? null : String(r.name),
        payout_ils: num(r.payout_ils),
        has_rate_gap: Boolean(r.has_rate_gap),
        sessions,
      });
    }
  }

  const at = o.athlete_totals;
  let athlete_totals: WeeklyFinanceAthleteTotals = {
    expected_ils: 0,
    collected_sessions_ils: 0,
    collected_account_ils: 0,
    collected_total_ils: 0,
    outstanding_ils: 0,
  };
  if (at && typeof at === "object") {
    const t = at as Record<string, unknown>;
    athlete_totals = {
      expected_ils: num(t.expected_ils),
      collected_sessions_ils: num(t.collected_sessions_ils),
      collected_account_ils: num(t.collected_account_ils),
      collected_total_ils: num(t.collected_total_ils),
      outstanding_ils: num(t.outstanding_ils),
    };
  }

  const athletesRaw = o.athletes;
  const athletes: WeeklyFinanceAthlete[] = [];
  if (Array.isArray(athletesRaw)) {
    for (const a of athletesRaw) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      const kind = r.kind === "manual" ? "manual" : "app";
      const id = String(r.id ?? "");
      if (!id) continue;
      athletes.push({
        kind,
        id,
        name: r.name == null ? null : String(r.name),
        expected_ils: num(r.expected_ils),
        collected_sessions_ils: num(r.collected_sessions_ils),
        collected_account_ils: num(r.collected_account_ils),
        collected_total_ils: num(r.collected_total_ils),
        outstanding_ils: num(r.outstanding_ils),
      });
    }
  }

  const amb = o.amounts_by_method;
  const amounts_by_method: Record<string, number> = {};
  if (amb && typeof amb === "object" && !Array.isArray(amb)) {
    for (const [k, v] of Object.entries(amb as Record<string, unknown>)) {
      amounts_by_method[k] = num(v);
    }
  }

  return { coaches, athlete_totals, athletes, amounts_by_method };
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
  const [data, setData] = useState<StatsPayload | null>(null);
  const [expandedCoachId, setExpandedCoachId] = useState<string | null>(null);
  const [showAthleteList, setShowAthleteList] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    let raw: unknown = null;
    let error: { message: string } | null = null;

    const primary = await supabase.rpc("manager_weekly_stats", {
      p_anchor: anchorDate,
      p_mode: periodMode,
    });
    raw = primary.data;
    error = primary.error;

    if (error && periodMode === "week" && isMissingRpcSignature(error)) {
      const legacy = await supabase.rpc("manager_weekly_stats", {
        p_week_start: anchorDate,
      });
      raw = legacy.data;
      error = legacy.error;
    }

    setLoading(false);

    if (error && periodMode === "month" && isMissingRpcSignature(primary.error)) {
      setData({ ok: false, error: t("dashboard.monthModeNeedsDb") });
      return;
    }

    if (error) {
      setData({ ok: false, error: error.message });
      return;
    }
    setData((raw as StatsPayload) ?? { ok: false });
  }, [anchorDate, periodMode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data?.ok && data.week_start && data.week_start !== anchorDate) {
      setAnchorDate(String(data.week_start));
    }
  }, [data?.ok, data?.week_start, anchorDate]);

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

  const finance = useMemo(() => parseFinance(data?.finance), [data?.finance]);

  function openWeeklyDetail(kind: string) {
    const ws = data?.week_start ?? anchorDate;
    const we = data?.week_end;
    if (!ws || !we) return;
    router.push({
      pathname: "/(app)/manager/weekly-detail",
      params: { weekStart: ws, weekEnd: we, kind },
    } as Href);
  }

  const paymentRows = useMemo(() => {
    const p = data?.payments_by_method ?? {};
    const merged = new Map<string, number>();
    for (const [k, v] of Object.entries(p)) {
      const canon = normalizePaymentMethodKey(k);
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      merged.set(canon, (merged.get(canon) ?? 0) + n);
    }
    return [...merged.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

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

  function openAthleteHistory(a: WeeklyFinanceAthlete) {
    if (a.kind !== "app") return;
    router.push(`/(app)/manager/participant-history?presetUserId=${encodeURIComponent(a.id)}` as Href);
  }

  const rangeLabelStart = data?.week_start ?? anchorDate;
  const rangeLabelEnd = data?.week_end;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ManagerOverviewHubTabs />
      <View style={[styles.titleBlock, isRTL && styles.titleBlockRtl]}>
        <Text style={[styles.h, isRTL && styles.rtl]}>
          {periodMode === "month" ? t("dashboard.monthlyOverview") : t("dashboard.weeklyOverview")}
        </Text>
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
        </View>
      </View>
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
            {rangeLabelEnd ? formatISODateFull(rangeLabelEnd, language) : "…"}
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

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={theme.colors.cta} />
        </View>
      ) : null}

      {!loading && data && !data.ok ? (
        <Text style={styles.err}>{data.error ?? t("common.error")}</Text>
      ) : null}

      {!loading && data?.ok ? (
        <>
          <Text style={[styles.sectionEyebrow, isRTL && styles.rtl]}>
            {periodMode === "month" ? t("dashboard.sectionThisMonth") : t("dashboard.sectionThisWeek")}
          </Text>
          <View style={styles.statsCard}>
            <View style={styles.statsGrid}>
              <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                <Pressable
                  onPress={() => openWeeklyDetail("avg_fill")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11yAvgFill")}
                >
                  <Text style={styles.tileL}>{t("dashboard.tileAvgFill")}</Text>
                  <Text style={styles.tileV}>{pct(data.utilization_avg_pct)}%</Text>
                </Pressable>
                <Pressable
                  onPress={() => openWeeklyDetail("cancellations")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11yCancellations")}
                >
                  <Text style={styles.tileL}>{t("dashboard.tileCancellations")}</Text>
                  <Text style={styles.tileV}>{data.cancellations ?? 0}</Text>
                </Pressable>
              </View>
              <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                <Pressable
                  onPress={() => openWeeklyDetail("no_shows")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11yNoShows")}
                >
                  <Text style={styles.tileL}>{t("dashboard.tileNoShows")}</Text>
                  <Text style={styles.tileV}>{data.no_shows ?? 0}</Text>
                </Pressable>
                <Pressable
                  onPress={() => openWeeklyDetail("sessions")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11ySessions")}
                >
                  <Text style={styles.tileL}>{t("dashboard.tileSessions")}</Text>
                  <Text style={styles.tileV}>{data.session_count ?? 0}</Text>
                </Pressable>
              </View>
              <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
                <Pressable
                  onPress={() => openWeeklyDetail("waitlist")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11yWaitlist")}
                >
                  <Text style={styles.tileL}>{t("dashboard.waitlist")}</Text>
                  <Text style={styles.tileV}>{data.waitlist_count ?? 0}</Text>
                </Pressable>
                <Pressable
                  onPress={() => openWeeklyDetail("checked_in")}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.a11yCheckedIn")}
                >
                  <Text style={styles.tileL}>{t("dashboard.checkedIn")}</Text>
                  <Text style={styles.tileV}>{data.checked_in_count ?? 0}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </>
      ) : null}

      {!loading && data?.ok && (data.session_count ?? 0) === 0 ? (
        <Text style={[styles.emptyWeek, isRTL && styles.rtl]}>
          {periodMode === "month" ? t("dashboard.noSessionsThisMonth") : t("dashboard.noSessionsThisWeek")}
        </Text>
      ) : null}

      {!loading && data?.ok && finance ? (
        <View style={styles.financeBlock}>
          <Text style={[styles.sectionEyebrow, styles.financeEyebrow, isRTL && styles.rtl]}>{t("dashboard.financeTitle")}</Text>

          <View style={styles.financeCard}>
            <Text style={[styles.financeCardTitle, isRTL && styles.rtl]}>{t("dashboard.financeCoachPayouts")}</Text>
            <Text style={[styles.financeHint, isRTL && styles.rtl]}>{t("dashboard.financeHintCoach")}</Text>
            <View style={[styles.moneyHero, isRTL && styles.moneyHeroRtl]}>
              <Text style={[styles.moneyHeroLbl, isRTL && styles.rtl]}>{t("dashboard.financeTotalToCoaches")}</Text>
              <Text style={[styles.moneyHeroVal, isRTL && styles.rtl]}>{formatIls(coachPayoutTotal, language)}</Text>
            </View>
            <Text style={[styles.tapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapCoachHint")}</Text>
            <View style={styles.coachList}>
              {finance.coaches.length === 0 ? (
                <Text style={[styles.muted, isRTL && styles.rtl]}>
                  {periodMode === "month" ? t("dashboard.financeNoSessionsInMonth") : t("dashboard.financeNoSessionsInWeek")}
                </Text>
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
                        <Text style={styles.chev}>{open ? "▾" : "▸"}</Text>
                      </Pressable>
                      {open ? (
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
                      ) : null}
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
              <View style={styles.moneyCell}>
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeExpected")}</Text>
                <Text style={[styles.moneyCellVal, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.expected_ils, language)}
                </Text>
              </View>
              <View style={styles.moneyCell}>
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeCollectedSessions")}</Text>
                <Text style={[styles.moneyCellVal, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.collected_sessions_ils, language)}
                </Text>
              </View>
              <View style={styles.moneyCell}>
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeCollectedAccount")}</Text>
                <Text style={[styles.moneyCellVal, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.collected_account_ils, language)}
                </Text>
              </View>
              <View style={styles.moneyCell}>
                <Text style={[styles.moneyCellLbl, isRTL && styles.rtl]}>{t("dashboard.financeCollectedTotal")}</Text>
                <Text style={[styles.moneyCellVal, styles.moneyCellAccent, isRTL && styles.rtl]}>
                  {formatIls(finance.athlete_totals.collected_total_ils, language)}
                </Text>
              </View>
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
                {formatIls(Math.abs(finance.athlete_totals.outstanding_ils), language)}
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

            {showAthleteList ? (
              <View style={styles.athleteList}>
                {finance.athletes.length === 0 ? (
                  <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.financeNoAthleteRows")}</Text>
                ) : (
                  finance.athletes.map((a) => {
                    const owe = a.outstanding_ils > 0.005;
                    const canTap = a.kind === "app";
                    return (
                      <Pressable
                        key={`${a.kind}-${a.id}`}
                        onPress={() => canTap && openAthleteHistory(a)}
                        disabled={!canTap}
                        style={({ pressed }) => [
                          styles.athleteRow,
                          canTap && pressed && styles.athleteRowPressed,
                          !canTap && { opacity: 1 },
                        ]}
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
                        {canTap ? (
                          <Text style={[styles.sessionTapHint, isRTL && styles.rtl]}>{t("dashboard.financeTapActivityReport")}</Text>
                        ) : null}
                      </Pressable>
                    );
                  })
                )}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {!loading && data?.ok ? (
        <View style={styles.paySectionCard}>
          <Text style={[styles.subh, isRTL && styles.rtl]}>{t("dashboard.paymentsByMethodCounts")}</Text>
          <Text style={[styles.hintLine, isRTL && styles.rtl]}>{t("dashboard.paymentsHint")}</Text>
          {paymentRows.length === 0 ? (
            <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.paymentsCountsEmpty")}</Text>
          ) : (
            <View style={[styles.payList, isRTL && styles.payListRtl]}>
              {paymentRows.map(([method, n]) => (
                <View key={method} style={[styles.payRow, isRTL && styles.payRowRtl]}>
                  <StatusChip label={paymentMethodDashboardLabel(method, language)} tone="neutral" />
                  <Text style={styles.payN}>{n}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}
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
  loadingWrap: { paddingVertical: theme.spacing.sm, alignItems: "center" },
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
    fontSize: 10,
    color: theme.colors.textSoft,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.05,
    textAlign: "center",
  },
  tileV: {
    marginTop: 8,
    fontSize: 24,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: -0.5,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
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
  amountsHeading: { marginTop: theme.spacing.md },
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
  muted: { color: theme.colors.textSoft },
  paySectionCard: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  payList: { gap: 8 },
  payListRtl: { alignItems: "stretch" },
  payRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  payRowRtl: { flexDirection: "row-reverse" },
  payN: { fontSize: 16, fontWeight: "900", color: theme.colors.cta },
  payAmt: { fontSize: 14, fontWeight: "900", color: theme.colors.success, fontVariant: ["tabular-nums"] },
  athleteList: { marginTop: 10, gap: 8 },
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
});
