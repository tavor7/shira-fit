import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Platform,
  ActivityIndicator,
} from "react-native";
import { router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { formatSessionStartTime } from "../lib/sessionTime";
import { isValidISODateString, lastNDaysRangeISO } from "../lib/isoDate";
import { formatISODateFullWithWeekdayAfter } from "../lib/dateFormat";
import type { ManagerCoachSessionReportRow } from "../types/database";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { CoachPickerSheet } from "../components/CoachPickerSheet";
import { PricingPickerField } from "../components/PricingPickerField";
import { ReportDateRangeControls } from "../components/ReportDateRangeControls";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { EmptyState } from "../components/EmptyState";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { CrossfadeSwap } from "../components/CrossfadeSwap";
import { useCountUp } from "../hooks/useCountUp";

function formatPayout(n: number) {
  return `${Math.round(n * 100) / 100} ₪`;
}

function CoachSessionReportCard({
  item,
  language,
  isRTL,
  onPress,
}: {
  item: ManagerCoachSessionReportRow;
  language: string;
  isRTL: boolean;
  onPress: () => void;
}) {
  const { t } = useI18n();
  const rtlRowFlip = isRTL && Platform.OS !== "web";
  const due = Number(item.coach_earnings_ils ?? 0);
  const lateCancels =
    typeof item.late_cancellations_within_24h === "number" ? item.late_cancellations_within_24h : 0;
  const missingRate = item.coach_rate_missing === true;
  const registeredDisplay = useCountUp(item.registered_count ?? 0);
  const arrivedDisplay = useCountUp(item.arrived_count ?? 0);
  const lateCancelsDisplay = useCountUp(lateCancels);

  return (
    <Pressable
      style={({ pressed }) => [styles.sessionCard, pressed && styles.sessionCardPressed]}
      onPress={onPress}
    >
      <View style={[styles.sessionHeadRow, rtlRowFlip && styles.sessionHeadRowRtl]}>
        <View style={[styles.sessionHeadMain, isRTL && styles.sessionHeadMainRtl]}>
          <Text style={[styles.cardDatePrimary, isRTL && styles.sessionHeadTextHe]} numberOfLines={2}>
            {formatISODateFullWithWeekdayAfter(item.session_date, language as "en" | "he")}
          </Text>
          <Text
            style={[
              styles.cardDateMeta,
              isRTL ? [styles.sessionHeadTextHe, styles.sessionHeadTimeHe] : styles.ltrText,
            ]}
            numberOfLines={1}
          >
            {formatSessionStartTime(item.start_time)}
          </Text>
        </View>
        <View style={[styles.sessionPayoutAside, isRTL && styles.sessionPayoutAsideHe]}>
          <View
            style={[
              styles.sessionPayoutPill,
              missingRate && styles.sessionPayoutPillMissing,
              !missingRate && due <= 0 && styles.sessionPayoutPillZero,
            ]}
          >
            <Text
              style={[
                styles.sessionPayoutAmt,
                missingRate && styles.sessionPayoutAmtMissing,
                !missingRate && due <= 0 && styles.sessionPayoutAmtZero,
                styles.ltrText,
              ]}
              numberOfLines={1}
            >
              {missingRate ? "—" : formatPayout(due)}
            </Text>
          </View>
          {!missingRate ? (
            <Text style={[styles.sessionPayoutMeta, isRTL && styles.sessionPayoutMetaHe]} numberOfLines={1}>
              {t("coachReport.payoutPeopleCount").replace("{n}", String(item.registered_count ?? 0))}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.statsRow, rtlRowFlip && styles.statsRowRtl]}>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{Math.round(registeredDisplay)}</Text>
          <Text style={[styles.statLabel, isRTL && styles.rtlText]}>{t("coachReport.statRegistered")}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{Math.round(arrivedDisplay)}</Text>
          <Text style={[styles.statLabel, isRTL && styles.rtlText]}>{t("coachReport.statArrived")}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={[styles.statValue, lateCancels > 0 && styles.statValueWarn]}>{Math.round(lateCancelsDisplay)}</Text>
          <Text style={[styles.statLabel, isRTL && styles.rtlText]}>{t("coachReport.statLateCancel")}</Text>
        </View>
      </View>

      {missingRate ? (
        <View style={[styles.sessionFoot, rtlRowFlip && styles.sessionFootRtl]}>
          <View style={styles.rateWarnPill}>
            <Text style={styles.rateWarnPillTxt}>{t("coachReport.noRateForSize")}</Text>
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

export default function ManagerCoachSessionsReportScreen({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const { language, t, isRTL } = useI18n();
  const { showOk } = useAppAlert();
  const defaultRange = useMemo(() => lastNDaysRangeISO(30), []);
  const [start, setStart] = useState(defaultRange.start);
  const [end, setEnd] = useState(defaultRange.end);
  const [coachId, setCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ManagerCoachSessionReportRow[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const payoutTotal = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.coach_earnings_ils ?? 0), 0),
    [rows]
  );
  const missingRateSessions = useMemo(
    () => rows.filter((r) => r.coach_rate_missing === true).length,
    [rows]
  );
  const payoutTotalDisplay = useCountUp(payoutTotal);

  const loadReport = useCallback(async () => {
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e)) {
      showOk(t("common.error"), t("coachReport.invalidDateRange"));
      return;
    }
    if (s > e) {
      showOk(t("common.error"), t("coachReport.startAfterEnd"));
      return;
    }
    if (!coachId) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("manager_coach_sessions_report", {
      p_start: s,
      p_end: e,
      p_coach_id: coachId,
    });
    setLoading(false);
    setHasSearched(true);
    if (error) {
      showOk(t("common.error"), error.message);
      setRows([]);
      return;
    }
    setRows((data as ManagerCoachSessionReportRow[]) ?? []);
  }, [start, end, coachId, language, t]);

  const loadRef = useRef(loadReport);
  loadRef.current = loadReport;

  useEffect(() => {
    if (!coachId) {
      setHasSearched(false);
      setRows([]);
      return;
    }
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e) || s > e) return;
    void loadRef.current();
  }, [coachId, start, end]);

  function onDateRangeChange(range: { start: string; end: string }) {
    setStart(range.start);
    setEnd(range.end);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        {!hideTitle ? (
          <Text style={[styles.screenTitle, isRTL && styles.rtlText]}>{t("menu.coachHistory")}</Text>
        ) : null}
        <ReportDateRangeControls start={start} end={end} onChange={onDateRangeChange} />
      </View>

      <View style={styles.coachPickCard}>
        <PricingPickerField
          label={t("sessionForm.trainer")}
          value={coachLabel}
          placeholder={t("sessionForm.chooseTrainer")}
          onPress={() => setPickerOpen(true)}
          isRTL={isRTL}
          accessibilityLabel={t("sessionForm.trainer")}
        />
      </View>

      <CrossfadeSwap
        loading={!!(coachId && loading)}
        skeleton={
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" color={theme.colors.cta} />
            <Text style={styles.loadingBannerTxt}>{t("common.loading")}</Text>
          </View>
        }
      >
      {hasSearched && coachId && !loading ? (
        <View style={styles.payoutCard}>
          <View style={[styles.payoutTop, isRTL && Platform.OS !== "web" && styles.payoutTopRtl]}>
            <View style={styles.payoutTopMain}>
              <Text style={[styles.payoutEyebrow, isRTL && styles.rtlText]}>{t("coachReport.payoutTitle")}</Text>
              <Text style={[styles.payoutBig, isRTL && styles.rtlText]}>{formatPayout(payoutTotalDisplay)}</Text>
            </View>
            <View style={styles.payoutBadge}>
              <Text style={styles.payoutBadgeTxt}>
                {t("coachReport.sessionCount").replace("{n}", String(rows.length))}
              </Text>
            </View>
          </View>
          {missingRateSessions > 0 ? (
            <Text style={[styles.payoutWarn, isRTL && styles.rtlText]}>
              {t("coachReport.sessionsMissingRate").replace("{n}", String(missingRateSessions))}
            </Text>
          ) : null}
        </View>
      ) : null}
      </CrossfadeSwap>

      <CoachPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedCoachId={coachId}
        onSelect={(coach) => {
          setCoachId(coach.user_id);
          setCoachLabel(coach.full_name);
        }}
      />

      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(item) => item.session_id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index }) => (
          <FadeSlideIn delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
            <CoachSessionReportCard
              item={item}
              language={language}
              isRTL={isRTL}
              onPress={() => router.push(`/(app)/manager/session/${item.session_id}` as Href)}
            />
          </FadeSlideIn>
        )}
        ListEmptyComponent={
          !coachId ? (
            <EmptyState icon="🏋️" title={t("coachReport.chooseTrainer")} isRTL={isRTL} />
          ) : !hasSearched || loading ? (
            <View style={styles.skeletonList}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : (
            <EmptyState icon="📭" title={t("coachReport.noSessionsInRange")} isRTL={isRTL} />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  skeletonList: { gap: theme.spacing.sm, padding: theme.spacing.md },
  filters: {
    margin: theme.spacing.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
  },
  screenTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.sm },
  rtlText: { textAlign: "right" },
  ltrText: { textAlign: "left", writingDirection: "ltr" },
  loadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: 10,
  },
  loadingBannerTxt: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  coachPickCard: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  list: { flex: 1 },
  listContent: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl, flexGrow: 1, gap: 10 },
  payoutCard: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  payoutTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  payoutTopRtl: { flexDirection: "row-reverse" },
  payoutTopMain: { flex: 1, minWidth: 0 },
  payoutEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  payoutBig: { fontSize: 28, fontWeight: "900", color: theme.colors.cta, marginTop: 4, letterSpacing: -0.5 },
  payoutBadge: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  payoutBadgeTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  payoutWarn: { fontSize: 12, fontWeight: "600", color: theme.colors.error, lineHeight: 17 },
  sessionCard: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  sessionCardPressed: { opacity: 0.92, transform: [{ scale: 0.995 }] },
  sessionHeadRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  sessionHeadRowRtl: { flexDirection: "row-reverse" },
  sessionHeadMain: { flex: 1, minWidth: 0, gap: 3 },
  sessionHeadMainRtl: { alignItems: "stretch" },
  sessionHeadTextHe: { alignSelf: "stretch", textAlign: "right", writingDirection: "rtl" },
  sessionHeadTimeHe: { writingDirection: "ltr", textAlign: "right" },
  cardDatePrimary: { fontSize: 15, fontWeight: "800", color: theme.colors.text, lineHeight: 21 },
  cardDateMeta: { fontSize: 14, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 20 },
  sessionPayoutAside: {
    alignItems: "flex-end",
    justifyContent: "flex-start",
    gap: 5,
    flexShrink: 0,
    minWidth: 88,
    maxWidth: "42%",
    paddingTop: 1,
  },
  sessionPayoutAsideHe: { alignItems: "flex-start" },
  sessionPayoutPill: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.4)",
  },
  sessionPayoutPillZero: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderMuted,
  },
  sessionPayoutPillMissing: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderMuted,
  },
  sessionPayoutAmt: { fontSize: 18, fontWeight: "900", color: theme.colors.success, letterSpacing: -0.3 },
  sessionPayoutAmtZero: { color: theme.colors.textMuted },
  sessionPayoutAmtMissing: { color: theme.colors.textSoft },
  sessionPayoutMeta: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textMuted,
    textAlign: "right",
    lineHeight: 14,
  },
  sessionPayoutMetaHe: { textAlign: "left", alignSelf: "flex-start" },
  statsRow: {
    flexDirection: "row",
    alignItems: "stretch",
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  statsRowRtl: { flexDirection: "row-reverse" },
  statCell: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12, paddingHorizontal: 6 },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: theme.colors.borderMuted },
  statValue: { fontSize: 20, fontWeight: "900", color: theme.colors.text, lineHeight: 24 },
  statValueWarn: { color: theme.colors.error },
  statLabel: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.2,
    textTransform: "uppercase",
    textAlign: "center",
  },
  sessionFoot: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  sessionFootRtl: { flexDirection: "row-reverse" },
  rateWarnPill: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
  },
  rateWarnPillTxt: { fontSize: 10, fontWeight: "800", color: theme.colors.error },
});
