import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView } from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { formatISODateFull } from "../lib/dateFormat";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";
import { useI18n } from "../context/I18nContext";
import { StatusChip } from "../components/StatusChip";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";

/** Local-calendar Sunday (matches server `public._week_start_sunday`). */
function startOfWeekSunday(d: Date): string {
  const cal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  cal.setDate(cal.getDate() - cal.getDay());
  return toISODateLocal(cal);
}

type StatsPayload = {
  ok?: boolean;
  error?: string;
  week_start?: string;
  week_end?: string;
  session_count?: number;
  utilization_avg_pct?: number;
  cancellations?: number;
  no_shows?: number;
  waitlist_count?: number;
  checked_in_count?: number;
  payments_by_method?: Record<string, number>;
};

export default function ManagerDashboardScreen() {
  const { language, isRTL, t } = useI18n();
  const pct = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const [weekStart, setWeekStart] = useState(() => startOfWeekSunday(new Date()));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<StatsPayload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: raw, error } = await supabase.rpc("manager_weekly_stats", { p_week_start: weekStart });
    setLoading(false);
    if (error) {
      setData({ ok: false, error: error.message });
      return;
    }
    setData((raw as StatsPayload) ?? { ok: false });
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data?.ok && data.week_start && data.week_start !== weekStart) {
      setWeekStart(String(data.week_start));
    }
  }, [data?.ok, data?.week_start, weekStart]);

  const paymentRows = useMemo(() => {
    const p = data?.payments_by_method ?? {};
    return Object.entries(p)
      .map(([k, v]) => [k, typeof v === "number" ? v : Number(v)] as [string, number])
      .filter(([, n]) => Number.isFinite(n))
      .sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ManagerOverviewTabs />
      <Text style={[styles.h, isRTL && styles.rtl]}>{t("dashboard.weeklyOverview")}</Text>
      <View style={[styles.weekNav, isRTL && styles.weekNavRtl]}>
        <Pressable style={({ pressed }) => [styles.navBtn, pressed && styles.navBtnPressed]} onPress={() => setWeekStart((w) => shiftWeek(w, -7))}>
          <Text style={styles.navBtnTxt}>{"<"}</Text>
        </Pressable>
        <Text style={styles.weekLbl} numberOfLines={1}>
          {formatISODateFull(data?.week_start ?? weekStart, language)}
          {" → "}
          {data?.week_end ? formatISODateFull(data.week_end, language) : "…"}
        </Text>
        <Pressable style={({ pressed }) => [styles.navBtn, pressed && styles.navBtnPressed]} onPress={() => setWeekStart((w) => shiftWeek(w, 7))}>
          <Text style={styles.navBtnTxt}>{">"}</Text>
        </Pressable>
      </View>

      {loading ? <ActivityIndicator color={theme.colors.cta} /> : null}

      {!loading && data && !data.ok ? (
        <Text style={styles.err}>{data.error ?? (language === "he" ? "שגיאה" : "Error")}</Text>
      ) : null}

      {!loading && data?.ok ? (
        <View style={styles.statsGrid}>
          <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{language === "he" ? "מילוי ממוצע" : "Avg fill"}</Text>
              <Text style={styles.tileV}>{pct(data.utilization_avg_pct)}%</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
              <Text style={styles.tileV}>{data.cancellations ?? 0}</Text>
            </View>
          </View>
          <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{language === "he" ? "אי־הגעות" : "No-shows"}</Text>
              <Text style={styles.tileV}>{data.no_shows ?? 0}</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{language === "he" ? "אימונים" : "Sessions"}</Text>
              <Text style={styles.tileV}>{data.session_count ?? 0}</Text>
            </View>
          </View>
          <View style={[styles.statsPair, isRTL && styles.statsPairRtl]}>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{t("dashboard.waitlist")}</Text>
              <Text style={styles.tileV}>{data.waitlist_count ?? 0}</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileL}>{t("dashboard.checkedIn")}</Text>
              <Text style={styles.tileV}>{data.checked_in_count ?? 0}</Text>
            </View>
          </View>
        </View>
      ) : null}

      {!loading && data?.ok && (data.session_count ?? 0) === 0 ? (
        <Text style={[styles.emptyWeek, isRTL && styles.rtl]}>{t("dashboard.noSessionsThisWeek")}</Text>
      ) : null}

      {!loading && data?.ok ? (
        <View style={{ marginTop: 16 }}>
          <Text style={[styles.subh, isRTL && styles.rtl]}>{language === "he" ? "תשלומים לפי סוג" : "Payments by method"}</Text>
          <Text style={[styles.hintLine, isRTL && styles.rtl]}>{t("dashboard.paymentsHint")}</Text>
          {paymentRows.length === 0 ? (
            <Text style={[styles.muted, isRTL && styles.rtl]}>{language === "he" ? "אין נתונים." : "No data."}</Text>
          ) : (
            <View style={[styles.payList, isRTL && styles.payListRtl]}>
              {paymentRows.map(([method, n]) => (
                <View key={method} style={[styles.payRow, isRTL && styles.payRowRtl]}>
                  <StatusChip label={method === "(none)" ? (language === "he" ? "לא צוין" : "Unspecified") : method} tone="neutral" />
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
  content: { padding: theme.spacing.md, paddingBottom: 40 },
  h: { fontSize: 20, fontWeight: "900", color: theme.colors.text, marginBottom: 12 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  weekNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  weekNavRtl: { flexDirection: "row-reverse" },
  navBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  navBtnPressed: { opacity: 0.85 },
  navBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 15 },
  weekLbl: {
    flex: 1,
    textAlign: "center",
    color: theme.colors.textMuted,
    fontWeight: "700",
    fontSize: 13,
    marginHorizontal: 8,
  },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 8 },
  statsGrid: { gap: 8 },
  statsPair: { flexDirection: "row", gap: 8 },
  statsPairRtl: { flexDirection: "row-reverse" },
  tile: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 16,
    paddingHorizontal: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
  },
  tileL: {
    fontSize: 10,
    color: theme.colors.textSoft,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.1,
    textAlign: "center",
  },
  tileV: {
    marginTop: 10,
    fontSize: 26,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: -0.5,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
  subh: { fontWeight: "800", color: theme.colors.text, marginBottom: 6 },
  hintLine: { fontSize: 12, color: theme.colors.textMuted, marginBottom: 10, lineHeight: 17 },
  emptyWeek: { marginTop: 12, fontSize: 14, fontWeight: "700", color: theme.colors.textSoft },
  muted: { color: theme.colors.textSoft },
  payList: { gap: 8 },
  payListRtl: { alignItems: "stretch" },
  payRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  payRowRtl: { flexDirection: "row-reverse" },
  payN: { fontSize: 16, fontWeight: "900", color: theme.colors.cta },
});
