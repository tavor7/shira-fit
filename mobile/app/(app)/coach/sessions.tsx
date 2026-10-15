import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";

import { fetchStaffTrainingSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession, fetchVisibleSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { fetchWaitlistCountsBySession } from "../../../src/lib/waitlistCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { StaffHomeOverview } from "../../../src/components/StaffHomeOverview";
import { StaffAthleteScheduleLookup } from "../../../src/components/StaffAthleteScheduleLookup";
import { useAuth } from "../../../src/context/AuthContext";
import { useI18n } from "../../../src/context/I18nContext";
import { mergeStaffHomeAlerts, type HomePriorityAlertItem } from "../../../src/lib/homePriorityAlerts";
import { HomePriorityAlerts } from "../../../src/components/HomePriorityAlerts";
import { AppText } from "../../../src/components/AppText";
import { touchWeeklyRegistrationOpenIfDue } from "../../../src/lib/touchWeeklyRegistrationOpen";
import { isSessionInActiveSeries, maintainSessionSeriesHorizon } from "../../../src/lib/sessionSeries";
import { fetchStudioCalendarNotesForRange, type StudioCalendarNote } from "../../../src/lib/studioCalendarNotes";
import { dedupeSessionsBySignupCount } from "../../../src/lib/dedupeSessionsBySlot";
import { displayTimeRange } from "../../../src/lib/displayFormat";
import { useScreenContentStyle } from "../../../src/hooks/useScreenLayout";
import { usePerfScreen } from "../../../src/hooks/usePerfScreen";
import { createLoadSequencer, showInitialSkeleton } from "../../../src/lib/screenRefresh";
import { UserScopedScreen } from "../../../src/components/UserScopedScreen";
import { RefreshFailedNotice } from "../../../src/components/RefreshFailedNotice";

export default function CoachSessionsScreen() {
  return (
    <UserScopedScreen>
      <CoachSessionsScreenContent />
    </UserScopedScreen>
  );
}

function CoachSessionsScreenContent() {
  const { profile } = useAuth();
  const screenContent = useScreenContentStyle("wide", { selfInset: theme.spacing.md });
  const { language, t, isRTL } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  /** Role-aware count for card display only — excludes athletes hidden from this coach's own view. Never use for capacity/dedup logic. */
  const [visibleSignupBySession, setVisibleSignupBySession] = useState<Record<string, number>>({});
  const [waitlistBySession, setWaitlistBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Performance Phase 1 / step 5: once the calendar has data, refreshes keep it on screen (no skeleton). */
  const [hasData, setHasData] = useState(false);
  const showSkeleton = showInitialSkeleton(loading, hasData);
  const [loadSeq] = useState(createLoadSequencer);
  usePerfScreen("coach.home", !showSkeleton);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [homeAlerts, setHomeAlerts] = useState<HomePriorityAlertItem[]>([]);
  const [weekRange, setWeekRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [studioNotes, setStudioNotes] = useState<StudioCalendarNote[]>([]);
  const weekRangeRef = useRef(weekRange);
  weekRangeRef.current = weekRange;
  const [priorityAlertsVisibleCount, setPriorityAlertsVisibleCount] = useState<number | null>(null);
  const homeAlertsSig = useMemo(() => homeAlerts.map((x) => x.id).sort().join("|"), [homeAlerts]);

  useEffect(() => {
    setPriorityAlertsVisibleCount(null);
  }, [homeAlertsSig]);

  const dismissStorageUserId = profile?.user_id ?? null;
  const showPriorityAlerts =
    homeAlerts.length > 0 && (priorityAlertsVisibleCount === null || priorityAlertsVisibleCount > 0);

  const alertsSeqRef = useRef(0);
  const load = useCallback(async (isRefresh: boolean) => {
    const ticket = loadSeq.next();
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    // Idempotent server-side backup for a late cron; doesn't need to block the fetch below.
    void touchWeeklyRegistrationOpenIfDue();
    void maintainSessionSeriesHorizon();
    // Performance Phase 1 / step 3: two request waves before the calendar shows (sessions + week notes, then the counts),
    // instead of five sequential steps. Alerts are computed afterwards: they use the same data but must not hold the
    // calendar back. The sequence guard keeps a slower, older alerts result from overwriting a newer one.
    const w = weekRangeRef.current;
    const [{ data, error }, notes] = await Promise.all([
      fetchStaffTrainingSessionsForCalendar(),
      w.start && w.end ? fetchStudioCalendarNotesForRange(w.start, w.end) : Promise.resolve(null),
    ]);
    if (!loadSeq.isLatest(ticket)) return;
    setLoadError(!!error);
    if (error) {
      // Step 5: a failed refresh keeps the sessions already on screen (it used to empty the calendar).
      setRefreshing(false);
      setLoading(false);
      return;
    }
    const list = data ? (data as TrainingSessionWithTrainer[]) : [];
    const ids = list.map((s) => s.id);
    const [signup, waitlist, visibleSignup] = await Promise.all([
      fetchActiveSignupCountsBySession(ids),
      fetchWaitlistCountsBySession(ids),
      fetchVisibleSignupCountsBySession(ids),
    ]);
    if (!loadSeq.isLatest(ticket)) return;
    // Sessions and their counts are applied together, so a refresh never shows new sessions with old counts.
    setRows(list);
    setSignupBySession(signup);
    setWaitlistBySession(waitlist);
    setVisibleSignupBySession(visibleSignup);
    if (notes) setStudioNotes(notes);
    setRefreshSeq((n) => n + 1);
    setHasData(true);

    setRefreshing(false);
    setLoading(false);

    const seq = ++alertsSeqRef.current;
    const alerts = await mergeStaffHomeAlerts("coach", list, signup, waitlist, language);
    if (seq === alertsSeqRef.current) setHomeAlerts(alerts);
  }, [language, loadSeq]);

  useEffect(() => {
    if (!weekRange.start || !weekRange.end) return;
    let cancelled = false;
    void fetchStudioCalendarNotesForRange(weekRange.start, weekRange.end).then((n) => {
      if (!cancelled) setStudioNotes(n);
    });
    return () => {
      cancelled = true;
    };
  }, [weekRange.start, weekRange.end]);

  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load])
  );

  const visibleRows = useMemo(
    () => dedupeSessionsBySignupCount(rows, signupBySession),
    [rows, signupBySession]
  );

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      visibleRows.map((s) => ({
        key: s.id,
        session_date: s.session_date,
        start_time: s.start_time,
        durationMinutes: s.duration_minutes ?? 60,
        timeLabel: displayTimeRange(s.start_time, s.duration_minutes ?? 60),
        trainerName: s.trainer?.full_name ?? undefined,
        coachId: s.coach_id,
        signedUpCount: visibleSignupBySession[s.id] ?? 0,
        maxParticipants: s.max_participants,
        waitlistCount: waitlistBySession[s.id] ?? 0,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        showStaffSessionLabels: true,
        isHidden: !!s.is_hidden,
        isOpenForRegistration: s.is_open_for_registration,
        isKickbox: !!s.is_kickbox,
        isRecurringSeries: isSessionInActiveSeries(s),
        onPress: () => router.push(`/(app)/coach/session/${s.id}`),
      })),
    [visibleRows, signupBySession, visibleSignupBySession, waitlistBySession]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.coachSessions") }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, screenContent]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[theme.colors.cta]} />}
      >
        {loadError && hasData ? <RefreshFailedNotice onRetry={() => void load(false)} /> : null}
        {loadError && !hasData ? (
          <View style={styles.errorBanner}>
            <AppText variant="caption" isRTL={isRTL} style={styles.errorBannerTxt}>
              {t("coachSessions.loadError")}
            </AppText>
          </View>
        ) : null}
        {showPriorityAlerts ? (
          <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm }}>
            <HomePriorityAlerts
              items={homeAlerts}
              dismissStorageUserId={dismissStorageUserId}
              onVisibleCountChange={setPriorityAlertsVisibleCount}
            />
          </View>
        ) : null}
        <StaffHomeOverview userId={profile?.user_id} sessions={rows} variant="coach" refreshSeq={refreshSeq} />
        <StaffAthleteScheduleLookup variant="coach" />
        <SessionsWeekCalendar
          items={items}
          isLoading={showSkeleton}
          emptyLabel={t("empty.noSessionsFound")}
          onDayPress={(iso) => setSheetDay(iso)}
          weekOffset={calendarWeekOffset}
          onWeekOffsetChange={setCalendarWeekOffset}
          onWeekChange={(startIso, endIso) => setWeekRange({ start: startIso, end: endIso })}
          calendarNotes={studioNotes}
        />
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="coach"
        calendarNotes={studioNotes}
        currentUserId={profile?.user_id ?? null}
        onAddSession={() => {
          const d = sheetDay;
          setSheetDay(null);
          if (d) router.push({ pathname: "/(app)/coach/create-session", params: { date: d } });
        }}
        onChanged={() => load(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: theme.spacing.lg },
  errorBanner: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
  },
  errorBannerTxt: { color: theme.colors.error },
});
