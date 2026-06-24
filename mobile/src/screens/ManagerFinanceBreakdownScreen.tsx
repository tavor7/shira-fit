import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Stack, useLocalSearchParams, router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { parseManagerPeriodMode } from "../lib/managerPeriodMode";
import { formatISODateFull } from "../lib/dateFormat";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { mergeFinanceBreakdownDays, parseFinance, type FinanceBreakdownDay } from "../lib/managerWeeklyStats";
import {
  formatFinanceIls,
  formatSessionRosterLine,
  formatSessionTimeShort,
} from "../lib/financeBreakdownFormat";

function AmountPair({
  expected,
  collected,
  language,
  t,
  isRTL,
  compact,
}: {
  expected: number;
  collected: number;
  language: string;
  t: (key: string) => string;
  isRTL: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.amountPair, isRTL && styles.amountPairRtl, compact && styles.amountPairCompact]}>
      <View style={[styles.amountCol, compact ? styles.amountColCompact : styles.amountColBanner]}>
        <Text style={[styles.amountLbl, compact && styles.amountLblCompact, isRTL && styles.rtl]}>
          {t("dashboard.financeBreakdownExpected")}
        </Text>
        <Text style={[styles.amountExpected, compact && styles.amountExpectedCompact, isRTL && styles.rtl]}>
          {formatFinanceIls(expected, language)}
        </Text>
      </View>
      {!compact ? <View style={styles.amountDivider} /> : null}
      <View style={[styles.amountCol, compact ? styles.amountColCompact : styles.amountColBanner]}>
        <Text style={[styles.amountLbl, compact && styles.amountLblCompact, isRTL && styles.rtl]}>
          {t("dashboard.financeBreakdownCollected")}
        </Text>
        <Text style={[styles.amountCollected, compact && styles.amountCollectedCompact, isRTL && styles.rtl]}>
          {formatFinanceIls(collected, language)}
        </Text>
      </View>
    </View>
  );
}

export default function ManagerFinanceBreakdownScreen() {
  const { language, isRTL, t } = useI18n();
  const params = useLocalSearchParams<{ anchor?: string; periodMode?: string }>();
  const anchor = String(params.anchor ?? "").trim();
  const periodMode = parseManagerPeriodMode(
    typeof params.periodMode === "string" ? params.periodMode : undefined
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<FinanceBreakdownDay[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!anchor) {
      setError(t("common.error"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.rpc("manager_weekly_stats", {
      p_anchor: anchor,
      p_mode: periodMode,
    });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    const raw = data as Record<string, unknown> | null;
    if (!raw?.ok) {
      setError(String(raw?.error ?? t("common.error")));
      return;
    }
    setRangeStart(String(raw.week_start ?? ""));
    setRangeEnd(String(raw.week_end ?? ""));
    setDays(mergeFinanceBreakdownDays(parseFinance(raw.finance)));
  }, [anchor, periodMode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      days.reduce(
        (acc, d) => ({
          expected: acc.expected + d.expected_ils,
          collected: acc.collected + d.collected_ils,
          sessions: acc.sessions + d.sessions_ils,
          account: acc.account + d.account_ils,
        }),
        { expected: 0, collected: 0, sessions: 0, account: 0 }
      ),
    [days]
  );

  const rangeLabel = useMemo(() => {
    if (!rangeStart || !rangeEnd) return "";
    if (rangeStart === rangeEnd) return formatISODateFull(rangeStart, language);
    return `${formatISODateFull(rangeStart, language)} – ${formatISODateFull(rangeEnd, language)}`;
  }, [rangeStart, rangeEnd, language]);

  return (
    <>
      <Stack.Screen options={{ title: t("dashboard.financeBreakdownTitle") }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ManagerOverviewHubTabs />
        <Text style={[styles.h, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownTitle")}</Text>
        {rangeLabel ? <Text style={[styles.sub, isRTL && styles.rtl]}>{rangeLabel}</Text> : null}

        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.cta} style={{ marginTop: 24 }} />
        ) : error ? (
          <Text style={[styles.err, isRTL && styles.rtl]}>{error}</Text>
        ) : days.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownEmpty")}</Text>
        ) : (
          <>
            <View style={[styles.totalBanner, isRTL && styles.totalBannerRtl]}>
              <AmountPair
                expected={totals.expected}
                collected={totals.collected}
                language={language}
                t={t}
                isRTL={isRTL}
              />
            </View>
            {totals.account > 0 ? (
              <Text style={[styles.accountNote, isRTL && styles.rtl]}>
                {t("dashboard.financeDailyAccountPayments")}: {formatFinanceIls(totals.account, language)}
              </Text>
            ) : null}
            <Text style={[styles.hint, isRTL && styles.rtl]}>{t("dashboard.financeBreakdownHint")}</Text>
            {days.map((d) => {
              const open = expandedDate === d.date;
              const dayGap = d.expected_ils - d.collected_ils;
              return (
                <View key={d.date} style={styles.dayWrap}>
                  <Pressable
                    onPress={() => setExpandedDate(open ? null : d.date)}
                    style={({ pressed }) => [styles.dayRow, pressed && styles.dayRowPressed]}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                  >
                    <Text style={[styles.dayDate, isRTL && styles.rtl]}>{formatISODateFull(d.date, language)}</Text>
                    <View style={[styles.dayAmtPair, isRTL && styles.dayAmtPairRtl]}>
                      <Text style={[styles.dayAmtExpected, isRTL && styles.rtl]}>
                        {formatFinanceIls(d.expected_ils, language)}
                      </Text>
                      <Text style={styles.dayAmtSep}>→</Text>
                      <Text style={[styles.dayAmtCollected, isRTL && styles.rtl]}>
                        {formatFinanceIls(d.collected_ils, language)}
                      </Text>
                    </View>
                    <Text style={styles.chev}>{open ? "▾" : "▸"}</Text>
                  </Pressable>
                  {open ? (
                    <View style={styles.sessionList}>
                      {d.sessions.length > 0 ? (
                        <>
                          <Text style={[styles.sectionLbl, isRTL && styles.rtl]}>{t("dashboard.financeDailyAtSessions")}</Text>
                          {d.sessions.map((s) => (
                            <Pressable
                              key={s.session_id}
                              onPress={() => router.push(`/(app)/manager/session/${s.session_id}` as Href)}
                              style={({ pressed }) => [styles.sessionRow, pressed && styles.sessionRowPressed]}
                              accessibilityRole="button"
                            >
                              <Text style={[styles.sessionTime, isRTL && styles.rtl]}>
                                {formatSessionTimeShort(s.start_time)}
                                {s.coach_name?.trim() ? ` · ${s.coach_name.trim()}` : ""}
                              </Text>
                              <AmountPair
                                expected={s.expected_ils}
                                collected={s.collected_ils}
                                language={language}
                                t={t}
                                isRTL={isRTL}
                                compact
                              />
                              <Text style={[styles.sessionStats, isRTL && styles.rtl]}>
                                {formatSessionRosterLine(s, t)}
                              </Text>
                              {Math.abs(s.expected_ils - s.collected_ils) > 0.005 ? (
                                <Text
                                  style={[
                                    styles.sessionGap,
                                    s.collected_ils < s.expected_ils ? styles.sessionGapOwe : styles.sessionGapAhead,
                                    isRTL && styles.rtl,
                                  ]}
                                >
                                  {s.collected_ils < s.expected_ils
                                    ? t("dashboard.financeBreakdownSessionGap").replace(
                                        "{n}",
                                        formatFinanceIls(s.expected_ils - s.collected_ils, language)
                                      )
                                    : t("dashboard.financeBreakdownSessionAhead").replace(
                                        "{n}",
                                        formatFinanceIls(s.collected_ils - s.expected_ils, language)
                                      )}
                                </Text>
                              ) : null}
                              <Text style={[styles.sessionTap, isRTL && styles.rtl]}>{t("dashboard.financeTapSession")}</Text>
                            </Pressable>
                          ))}
                        </>
                      ) : null}
                      {d.account_ils > 0 ? (
                        <View style={styles.accountBlock}>
                          <Text style={[styles.sectionLbl, isRTL && styles.rtl]}>
                            {t("dashboard.financeDailyAccountPayments")}
                          </Text>
                          <View style={[styles.accountRow, isRTL && styles.accountRowRtl]}>
                            <Text style={[styles.accountLbl, isRTL && styles.rtl]}>
                              {t("dashboard.financeDailyAccountPaymentsDesc")}
                            </Text>
                            <Text style={[styles.accountAmt, isRTL && styles.rtl]}>
                              {formatFinanceIls(d.account_ils, language)}
                            </Text>
                          </View>
                        </View>
                      ) : null}
                      {Math.abs(dayGap) > 0.005 && d.sessions.length > 0 ? (
                        <Text
                          style={[
                            styles.dayGapNote,
                            d.collected_ils < d.expected_ils ? styles.sessionGapOwe : styles.sessionGapAhead,
                            isRTL && styles.rtl,
                          ]}
                        >
                          {d.collected_ils < d.expected_ils
                            ? t("dashboard.financeBreakdownDayGap").replace("{n}", formatFinanceIls(dayGap, language))
                            : t("dashboard.financeBreakdownDayAhead").replace(
                                "{n}",
                                formatFinanceIls(d.collected_ils - d.expected_ils, language)
                              )}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  h: { fontSize: 22, fontWeight: "900", color: theme.colors.text, marginBottom: 4 },
  sub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  rtl: { textAlign: "right", writingDirection: "rtl" },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 12 },
  muted: { color: theme.colors.textSoft, fontWeight: "600", marginTop: 12 },
  hint: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginBottom: theme.spacing.sm },
  totalBanner: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
  },
  totalBannerRtl: { alignItems: "stretch" },
  amountPair: { flexDirection: "row", alignItems: "stretch" },
  amountPairRtl: { flexDirection: "row-reverse" },
  amountPairCompact: { marginTop: 8, gap: 12 },
  amountCol: { flex: 1, minWidth: 0 },
  amountColBanner: { alignItems: "center", justifyContent: "center", paddingVertical: 4 },
  amountColCompact: { alignItems: "flex-start" },
  amountDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: 2,
  },
  amountLbl: { fontSize: 10, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", letterSpacing: 0.5 },
  amountLblCompact: { fontSize: 9 },
  amountExpected: { marginTop: 4, fontSize: 20, fontWeight: "900", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  amountExpectedCompact: { marginTop: 2, fontSize: 14, fontWeight: "900", color: theme.colors.cta },
  amountCollected: { marginTop: 4, fontSize: 20, fontWeight: "900", color: theme.colors.success, fontVariant: ["tabular-nums"] },
  amountCollectedCompact: { marginTop: 2, fontSize: 14, fontWeight: "900" },
  accountNote: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  dayWrap: { marginBottom: 8 },
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  dayRowPressed: { opacity: 0.9 },
  dayDate: { flex: 1, fontSize: 14, fontWeight: "800", color: theme.colors.text, minWidth: 72 },
  dayAmtPair: { flexDirection: "row", alignItems: "center", gap: 6 },
  dayAmtPairRtl: { flexDirection: "row-reverse" },
  dayAmtExpected: { fontSize: 13, fontWeight: "800", color: theme.colors.cta, fontVariant: ["tabular-nums"] },
  dayAmtSep: { fontSize: 11, color: theme.colors.textSoft, fontWeight: "700" },
  dayAmtCollected: { fontSize: 13, fontWeight: "800", color: theme.colors.success, fontVariant: ["tabular-nums"] },
  chev: { color: theme.colors.textSoft, fontSize: 12, fontWeight: "700" },
  sessionList: {
    marginTop: 4,
    marginLeft: 8,
    marginRight: 8,
    paddingBottom: 4,
    gap: 8,
  },
  sectionLbl: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 4,
    marginBottom: 2,
  },
  sessionRow: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  sessionRowPressed: { opacity: 0.9 },
  sessionTime: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  sessionStats: { marginTop: 6, fontSize: 11, fontWeight: "700", color: theme.colors.textMuted, lineHeight: 15 },
  sessionGap: { marginTop: 4, fontSize: 11, fontWeight: "800" },
  sessionGapOwe: { color: theme.colors.error },
  sessionGapAhead: { color: theme.colors.success },
  dayGapNote: { marginTop: 4, fontSize: 12, fontWeight: "800", textAlign: "center" },
  sessionTap: { marginTop: 6, fontSize: 11, fontWeight: "700", color: theme.colors.textSoft },
  accountBlock: { marginTop: 4, gap: 6 },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  accountRowRtl: { flexDirection: "row-reverse" },
  accountLbl: { flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 16 },
  accountAmt: { fontSize: 14, fontWeight: "900", color: theme.colors.success, fontVariant: ["tabular-nums"] },
});
