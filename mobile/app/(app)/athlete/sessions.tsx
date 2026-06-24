import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Pressable } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import { formatSessionTimeRange, hasSessionNotEnded, sessionStartsAt } from "../../../src/lib/sessionTime";
import { supabase } from "../../../src/lib/supabase";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";
import { fetchAthleteOpenSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { formatISODateWeekdayDayMonth } from "../../../src/lib/dateFormat";
import { firstWordOfDisplayName } from "../../../src/lib/displayName";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { useI18n } from "../../../src/context/I18nContext";
import { useToast } from "../../../src/context/ToastContext";
import { checkWaitlistSpotsAndNotify } from "../../../src/lib/waitlistSpotNotifier";
import { syncExpoPushTokenIfNeeded } from "../../../src/lib/pushTokenSync";
import { touchWeeklyRegistrationOpenIfDue } from "../../../src/lib/touchWeeklyRegistrationOpen";
import { fetchAthleteHomeAlertItems, type HomePriorityAlertItem } from "../../../src/lib/homePriorityAlerts";
import { HomePriorityAlerts } from "../../../src/components/HomePriorityAlerts";
import { useAuth } from "../../../src/context/AuthContext";
import { appendNetworkHint } from "../../../src/lib/networkErrors";
import { fetchStudioCalendarNotesForRange, type StudioCalendarNote } from "../../../src/lib/studioCalendarNotes";
import {
  weekBoundsSunday,
  studioTodayIso,
  ATHLETE_BROWSE_MAX_WEEK_OFFSET,
} from "../../../src/lib/studioWeek";
import { AppText } from "../../../src/components/AppText";
import { EmptyState } from "../../../src/components/EmptyState";

export default function AthleteSessionsScreen() {
  const { profile, session } = useAuth();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [myRegSessionIds, setMyRegSessionIds] = useState<string[]>([]);
  const [myWaitlistSessionIds, setMyWaitlistSessionIds] = useState<string[]>([]);
  const [waitlistJoiningId, setWaitlistJoiningId] = useState<string | null>(null);
  const waitlistBusyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const defaultWeek = useMemo(() => weekBoundsSunday(studioTodayIso()), []);
  const [myUpcoming, setMyUpcoming] = useState<TrainingSessionWithTrainer[]>([]);
  const [homeAlerts, setHomeAlerts] = useState<HomePriorityAlertItem[]>([]);
  const [priorityAlertsVisibleCount, setPriorityAlertsVisibleCount] = useState<number | null>(null);
  const [weekRange, setWeekRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [studioNotes, setStudioNotes] = useState<StudioCalendarNote[]>([]);
  const weekRangeRef = useRef(weekRange);
  weekRangeRef.current = weekRange;
  const homeAlertsSig = useMemo(() => homeAlerts.map((x) => x.id).sort().join("|"), [homeAlerts]);

  useEffect(() => {
    setPriorityAlertsVisibleCount(null);
  }, [homeAlertsSig]);

  const dismissStorageUserId = profile?.user_id ?? session?.user?.id ?? null;
  const showPriorityAlerts =
    homeAlerts.length > 0 && (priorityAlertsVisibleCount === null || priorityAlertsVisibleCount > 0);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    await touchWeeklyRegistrationOpenIfDue();
    const [calendarRes, alertItems] = await Promise.all([
      fetchAthleteOpenSessionsForCalendar(),
      fetchAthleteHomeAlertItems(language),
    ]);
    setHomeAlerts(alertItems);
    const { data, error } = calendarRes;
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    setSignupBySession(await fetchActiveSignupCountsBySession(list.map((s) => s.id)));

    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (uid && list.length > 0) {
      const ids = list.map((s) => s.id);
      const [regRes, wlRes] = await Promise.all([
        supabase.from("session_registrations").select("session_id").eq("user_id", uid).eq("status", "active").in("session_id", ids),
        supabase.from("waitlist_requests").select("session_id").eq("user_id", uid).in("session_id", ids),
      ]);
      setMyRegSessionIds((regRes.data ?? []).map((r) => String((r as { session_id: string }).session_id)));
      setMyWaitlistSessionIds((wlRes.data ?? []).map((r) => String((r as { session_id: string }).session_id)));
    } else {
      setMyRegSessionIds([]);
      setMyWaitlistSessionIds([]);
    }

    const w = weekRangeRef.current;
    if (w.start && w.end) {
      setStudioNotes(await fetchStudioCalendarNotesForRange(w.start, w.end));
    } else {
      setStudioNotes(await fetchStudioCalendarNotesForRange(defaultWeek.start, defaultWeek.end));
    }

    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, [language, defaultWeek.start, defaultWeek.end]);

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

  const joinWaitlistForSession = useCallback(
    async (sessionId: string) => {
      if (waitlistBusyRef.current) return;
      const sess = rows.find((x) => x.id === sessionId);
      if (
        sess &&
        !hasSessionNotEnded(sess.session_date, sess.start_time, sess.duration_minutes ?? 60)
      ) {
        showToast({
          message: t("athleteCalendar.waitlistHeading"),
          detail: t("athleteSession.sessionEndedNoRegister"),
          variant: "error",
        });
        return;
      }
      waitlistBusyRef.current = true;
      setWaitlistJoiningId(sessionId);
      try {
        const { data, error } = await supabase.rpc("request_waitlist", { p_session_id: sessionId });
        if (error) {
          showToast({
            message: t("common.error"),
            detail: appendNetworkHint(error, t("network.offlineHint")),
            variant: "error",
          });
        } else if (data?.ok) {
          showToast({ message: t("athleteCalendar.waitlistJoinedToast"), variant: "success" });
          setMyWaitlistSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
        } else {
          showToast({
            message: t("athleteCalendar.waitlistHeading"),
            detail: typeof data?.error === "string" ? data.error : "",
            variant: "error",
          });
        }
      } finally {
        waitlistBusyRef.current = false;
        setWaitlistJoiningId(null);
      }
    },
    [rows, showToast, t]
  );

  const loadMyUpcoming = useCallback(async () => {
    const { data: authUser } = await supabase.auth.getUser();
    const uid = authUser?.user?.id;
    if (!uid) {
      setMyUpcoming([]);
      return;
    }

    const { data, error } = await supabase
      .from("session_registrations")
      .select(
        `training_sessions!inner(
          id,
          session_date,
          start_time,
          coach_id,
          duration_minutes,
          max_participants,
          is_open_for_registration,
          is_hidden,
          trainer:profiles!coach_id(full_name, calendar_color)
        )`
      )
      .eq("user_id", uid)
      .eq("status", "active");

    if (error || !data) {
      setMyUpcoming([]);
      return;
    }

    const now = new Date();
    const sessions: TrainingSessionWithTrainer[] = [];
    for (const r of data as any[]) {
      const s = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
      if (!s?.id) continue;
      const startsAt = sessionStartsAt(s.session_date, s.start_time);
      if (startsAt.getTime() <= now.getTime()) continue; // only yet-to-occur
      sessions.push(s as TrainingSessionWithTrainer);
    }

    sessions.sort(
      (a, b) => sessionStartsAt(a.session_date, a.start_time).getTime() - sessionStartsAt(b.session_date, b.start_time).getTime()
    );
    setMyUpcoming(sessions);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(false);
      void loadMyUpcoming();
      void syncExpoPushTokenIfNeeded();
      void checkWaitlistSpotsAndNotify(language === "he" ? "he" : "en");
    }, [load, loadMyUpcoming, language])
  );

  const regSet = useMemo(() => new Set(myRegSessionIds), [myRegSessionIds.join("|")]);
  const wlSet = useMemo(() => new Set(myWaitlistSessionIds), [myWaitlistSessionIds.join("|")]);

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      rows.map((s) => {
        const c = signupBySession[s.id] ?? 0;
        const m = s.max_participants;
        const full = m > 0 && c >= m;
        const regOpen = !!s.is_open_for_registration;
        const sessionNotEnded = hasSessionNotEnded(s.session_date, s.start_time, s.duration_minutes ?? 60);
        const registered = regSet.has(s.id);
        const waitlisted = wlSet.has(s.id);
        const showJoinWl = full && regOpen && sessionNotEnded && !registered && !waitlisted;

        return {
          key: s.id,
          session_date: s.session_date,
          start_time: s.start_time,
          durationMinutes: s.duration_minutes ?? 60,
          timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
          trainerName: s.trainer?.full_name ?? undefined,
          coachId: s.coach_id,
          signedUpCount: c,
          maxParticipants: m,
          accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
          isKickbox: !!s.is_kickbox,
          isOpenForRegistration: regOpen,
          athleteRegistered: registered,
          athleteOnWaitlist: waitlisted,
          onJoinWaitlist: showJoinWl ? () => void joinWaitlistForSession(s.id) : undefined,
          waitlistJoining: waitlistJoiningId === s.id,
          onPress: () => router.push(`/(app)/athlete/session/${s.id}`),
        };
      }),
    [rows, signupBySession, regSet, wlSet, joinWaitlistForSession, waitlistJoiningId]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.athleteSessions") }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              await load(true);
              await loadMyUpcoming();
            }}
            colors={[theme.colors.cta]}
          />
        }
      >
        {showPriorityAlerts ? (
          <View style={styles.alertsTop}>
            <HomePriorityAlerts
              items={homeAlerts}
              dismissStorageUserId={dismissStorageUserId}
              onVisibleCountChange={setPriorityAlertsVisibleCount}
            />
          </View>
        ) : null}
        <View
          style={[
            styles.myUpcomingCard,
            { marginTop: showPriorityAlerts ? theme.spacing.sm : theme.spacing.md },
          ]}
        >
          <AppText variant="title" isRTL={isRTL} style={styles.myUpcomingTitle}>
            {t("athleteSessions.upcomingTitle")}
          </AppText>
          {myUpcoming.length === 0 ? (
            <EmptyState
              title={t("athleteSessions.noUpcoming")}
              isRTL={isRTL}
              style={styles.myUpcomingEmpty}
            />
          ) : (
            <View style={styles.myUpcomingList}>
              {myUpcoming.map((s) => {
                const trainer = s.trainer?.full_name ? firstWordOfDisplayName(s.trainer.full_name) : "";
                const time = formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60);
                const meta = trainer ? `${time} · ${trainer}` : time;
                const accent = resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id);
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => router.push(`/(app)/athlete/session/${s.id}`)}
                    style={({ pressed }) => [styles.upcomingRow, pressed && { opacity: 0.88 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${formatISODateWeekdayDayMonth(s.session_date, language)} ${meta}`}
                  >
                    {accent ? <View style={[styles.upcomingAccent, { backgroundColor: accent }]} /> : null}
                    <View style={[styles.upcomingBody, isRTL && styles.upcomingBodyRtl]}>
                      <AppText variant="body" isRTL={isRTL} style={styles.upcomingDay}>
                        {formatISODateWeekdayDayMonth(s.session_date, language)}
                      </AppText>
                      <AppText variant="caption" muted isRTL={isRTL} numberOfLines={1} style={styles.upcomingMeta}>
                        {meta}
                      </AppText>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={t("dashboard.noSessionsThisWeek")}
          onDayPress={(iso) => setSheetDay(iso)}
          weekOffset={calendarWeekOffset}
          onWeekOffsetChange={setCalendarWeekOffset}
          maxWeekOffset={ATHLETE_BROWSE_MAX_WEEK_OFFSET}
          onWeekChange={(startIso, endIso) => setWeekRange({ start: startIso, end: endIso })}
          calendarNotes={studioNotes}
        />
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="athlete"
        calendarNotes={studioNotes}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, flex: 1, justifyContent: "flex-start", paddingHorizontal: theme.spacing.md },
  alertsTop: { marginTop: theme.spacing.md },
  myUpcomingCard: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    gap: theme.spacing.sm,
  },
  myUpcomingTitle: { fontWeight: "900" },
  myUpcomingEmpty: { paddingVertical: theme.spacing.sm },
  myUpcomingList: { gap: theme.spacing.xs },
  upcomingRow: {
    flexDirection: "row",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.backgroundAlt,
    overflow: "hidden",
  },
  upcomingAccent: { width: 3, alignSelf: "stretch" },
  upcomingBody: { flex: 1, paddingVertical: 10, paddingHorizontal: theme.spacing.sm, gap: 2 },
  upcomingBodyRtl: { alignItems: "flex-end" },
  upcomingDay: { letterSpacing: 0.1 },
  upcomingMeta: {},
});
