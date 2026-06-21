import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Pressable, ActivityIndicator, Text } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";
import { formatSessionTimeRange } from "../../../src/lib/sessionTime";
import { fetchStaffTrainingSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { fetchWaitlistCountsBySession } from "../../../src/lib/waitlistCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { StaffHomeOverview } from "../../../src/components/StaffHomeOverview";
import { StaffAthleteScheduleLookup } from "../../../src/components/StaffAthleteScheduleLookup";
import { PrimaryButton } from "../../../src/components/PrimaryButton";
import { useAuth } from "../../../src/context/AuthContext";
import { useI18n } from "../../../src/context/I18nContext";
import { useAppAlert } from "../../../src/context/AppAlertContext";
import { supabase } from "../../../src/lib/supabase";
import { mergeStaffHomeAlerts, type HomePriorityAlertItem } from "../../../src/lib/homePriorityAlerts";
import { HomePriorityAlerts } from "../../../src/components/HomePriorityAlerts";
import { touchWeeklyRegistrationOpenIfDue } from "../../../src/lib/touchWeeklyRegistrationOpen";
import { isSessionInActiveSeries, maintainSessionSeriesHorizon } from "../../../src/lib/sessionSeries";
import { fetchStudioCalendarNotesForRange, type StudioCalendarNote } from "../../../src/lib/studioCalendarNotes";
import { dedupeSessionsBySignupCount } from "../../../src/lib/dedupeSessionsBySlot";

export default function ManagerSessionsScreen() {
  const { profile } = useAuth();
  const { language, t } = useI18n();
  const { showOk, showConfirm } = useAppAlert();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [waitlistBySession, setWaitlistBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  /** Keeps the calendar week when navigating to session detail and back. */
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [weekStartIso, setWeekStartIso] = useState<string>("");
  const [weekRange, setWeekRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [studioNotes, setStudioNotes] = useState<StudioCalendarNote[]>([]);
  const weekRangeRef = useRef(weekRange);
  weekRangeRef.current = weekRange;
  const [openWeekBusy, setOpenWeekBusy] = useState(false);
  const [homeAlerts, setHomeAlerts] = useState<HomePriorityAlertItem[]>([]);
  const [priorityAlertsVisibleCount, setPriorityAlertsVisibleCount] = useState<number | null>(null);
  const homeAlertsSig = useMemo(() => homeAlerts.map((x) => x.id).sort().join("|"), [homeAlerts]);

  useEffect(() => {
    setPriorityAlertsVisibleCount(null);
  }, [homeAlertsSig]);

  const dismissStorageUserId = profile?.user_id ?? null;
  const showPriorityAlerts =
    homeAlerts.length > 0 && (priorityAlertsVisibleCount === null || priorityAlertsVisibleCount > 0);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    await touchWeeklyRegistrationOpenIfDue();
    void maintainSessionSeriesHorizon();
    const { data, error } = await fetchStaffTrainingSessionsForCalendar();
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    const ids = list.map((s) => s.id);
    const signup = await fetchActiveSignupCountsBySession(ids);
    const waitlist = await fetchWaitlistCountsBySession(ids);
    setSignupBySession(signup);
    setWaitlistBySession(waitlist);
    setHomeAlerts(await mergeStaffHomeAlerts("manager", list, signup, waitlist, language));
    setRefreshSeq((n) => n + 1);

    const w = weekRangeRef.current;
    if (w.start && w.end) {
      setStudioNotes(await fetchStudioCalendarNotesForRange(w.start, w.end));
    }

    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, [language]);

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
        timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
        trainerName: s.trainer?.full_name ?? undefined,
        coachId: s.coach_id,
        signedUpCount: signupBySession[s.id] ?? 0,
        maxParticipants: s.max_participants,
        waitlistCount: waitlistBySession[s.id] ?? 0,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        showStaffSessionLabels: true,
        isHidden: !!s.is_hidden,
        isOpenForRegistration: s.is_open_for_registration,
        isKickbox: !!s.is_kickbox,
        isRecurringSeries: isSessionInActiveSeries(s),
        onPress: () => router.push(`/(app)/manager/session/${s.id}`),
      })),
    [visibleRows, signupBySession, waitlistBySession]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  async function openSelectedWeek() {
    if (!weekStartIso) return;
    const msg =
      language === "he"
        ? "לפתוח להרשמה את כל האימונים בשבוע הזה (א׳–ש׳), שאינם מוסתרים?"
        : "Open registration for all non-hidden sessions in this week (Sun–Sat)?";
    const title = language === "he" ? "פתיחת שבוע" : "Open week";

    const run = async () => {
      setOpenWeekBusy(true);
      const { data, error } = await supabase.rpc("open_sessions_for_week", { p_week_start: weekStartIso });
      setOpenWeekBusy(false);
      if (error) {
        showOk(language === "he" ? "שגיאה" : "Error", error.message);
        return;
      }
      if (!data?.ok) {
        const m = data?.error ?? "";
        showOk(language === "he" ? "נכשל" : "Failed", m);
        return;
      }
      const doneMsg = language === "he" ? `נפתחו ${data.opened ?? 0} אימונים.` : `Opened ${data.opened ?? 0} sessions.`;
      showOk(language === "he" ? "נפתח" : "Opened", doneMsg);
      load(true);
    };

    showConfirm({
      title,
      message: msg,
      cancelLabel: language === "he" ? "ביטול" : "Cancel",
      confirmLabel: language === "he" ? "פתיחה" : "Open",
      confirmVariant: "primary",
      onConfirm: () => void run(),
    });
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.managerSessions") }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[theme.colors.cta]} />}
      >
        {showPriorityAlerts ? (
          <View style={styles.alertsWrap}>
            <HomePriorityAlerts
              items={homeAlerts}
              dismissStorageUserId={dismissStorageUserId}
              onVisibleCountChange={setPriorityAlertsVisibleCount}
            />
          </View>
        ) : null}
        <StaffHomeOverview userId={profile?.user_id} sessions={rows} variant="manager" refreshSeq={refreshSeq} />
        <StaffAthleteScheduleLookup variant="manager" />
        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "לא נמצאו אימונים." : "No sessions found."}
          onDayPress={(iso) => setSheetDay(iso)}
          weekOffset={calendarWeekOffset}
          onWeekOffsetChange={setCalendarWeekOffset}
          onWeekChange={(startIso, endIso) => {
            setWeekRange({ start: startIso, end: endIso });
            setWeekStartIso(startIso);
          }}
          calendarNotes={studioNotes}
        />
        {weekStartIso ? (
          <View style={styles.weekActions}>
            <PrimaryButton
              label={language === "he" ? "פתיחת הרשמה לשבוע המוצג" : "Open registration for shown week"}
              onPress={() => void openSelectedWeek()}
              loading={openWeekBusy}
              loadingLabel={t("common.loading")}
            />
          </View>
        ) : null}
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="manager"
        calendarNotes={studioNotes}
        onCalendarNotesChanged={async () => {
          if (weekRange.start && weekRange.end) {
            setStudioNotes(await fetchStudioCalendarNotesForRange(weekRange.start, weekRange.end));
          }
        }}
        onAddSession={() => {
          const d = sheetDay;
          setSheetDay(null);
          if (d) router.push({ pathname: "/(app)/manager/create-session", params: { date: d } });
        }}
        onChanged={() => void load(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: theme.spacing.lg },
  alertsWrap: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm },
  weekActions: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.md },
});
