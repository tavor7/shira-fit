import { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import { formatSessionTimeRange } from "../../../src/lib/sessionTime";
import { supabase } from "../../../src/lib/supabase";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";
import { fetchAthleteOpenSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { ActionButton } from "../../../src/components/ActionButton";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { useI18n } from "../../../src/context/I18nContext";
import { checkWaitlistSpotsAndNotify } from "../../../src/lib/waitlistSpotNotifier";
import { syncExpoPushTokenIfNeeded } from "../../../src/lib/pushTokenSync";
import { sessionStartsAt } from "../../../src/lib/sessionTime";
import { touchWeeklyRegistrationOpenIfDue } from "../../../src/lib/touchWeeklyRegistrationOpen";
import { fetchAthleteHomeAlertItems, type HomePriorityAlertItem } from "../../../src/lib/homePriorityAlerts";
import { HomePriorityAlerts } from "../../../src/components/HomePriorityAlerts";
import { useAuth } from "../../../src/context/AuthContext";

export default function AthleteSessionsScreen() {
  const { profile, session } = useAuth();
  const { language, t } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [myUpcoming, setMyUpcoming] = useState<TrainingSessionWithTrainer[]>([]);
  const [calendarWeekEndIso, setCalendarWeekEndIso] = useState<string | null>(null);
  const [homeAlerts, setHomeAlerts] = useState<HomePriorityAlertItem[]>([]);
  const [priorityAlertsVisibleCount, setPriorityAlertsVisibleCount] = useState<number | null>(null);
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
    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, [language]);

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

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      rows.map((s) => ({
        key: s.id,
        session_date: s.session_date,
        start_time: s.start_time,
        durationMinutes: s.duration_minutes ?? 60,
        timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
        trainerName: s.trainer?.full_name ?? undefined,
        coachId: s.coach_id,
        signedUpCount: signupBySession[s.id] ?? 0,
        maxParticipants: s.max_participants,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        isOpenForRegistration: !!s.is_open_for_registration,
        onPress: () => router.push(`/(app)/athlete/session/${s.id}`),
      })),
    [rows, signupBySession]
  );

  const myUpcomingAfterCalendar = useMemo(() => {
    if (!calendarWeekEndIso) return myUpcoming;
    return myUpcoming.filter((s) => s.session_date > calendarWeekEndIso);
  }, [myUpcoming, calendarWeekEndIso]);

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
          <Text style={styles.myUpcomingTitle}>{language === "he" ? "הסימונים שלך (מתוכנן)" : "Your upcoming sessions"}</Text>
          {myUpcomingAfterCalendar.length === 0 ? (
            <Text style={styles.myUpcomingEmpty}>{language === "he" ? "אין עוד אימונים שלך." : "No upcoming sessions."}</Text>
          ) : (
            <View style={styles.myUpcomingList}>
              {myUpcomingAfterCalendar.map((s) => (
                <ActionButton
                  key={s.id}
                  label={`${formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60)} · ${s.session_date}`}
                  onPress={() => router.push(`/(app)/athlete/session/${s.id}`)}
                />
              ))}
            </View>
          )}
        </View>

        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "אין אימונים פתוחים עדיין (חמישי 08:00 פותח את שבוע הבא)." : "No sessions open yet (Thu 08:00 opens next week)."}
          onDayPress={(iso) => setSheetDay(iso)}
          onWeekChange={(_weekStartIso, weekEndIso) => setCalendarWeekEndIso(weekEndIso)}
        />
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="athlete"
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
  myUpcomingTitle: { fontWeight: "900", color: theme.colors.text, fontSize: 16 },
  myUpcomingEmpty: { color: theme.colors.textMuted, fontWeight: "700" },
  myUpcomingList: { gap: theme.spacing.sm },
});
