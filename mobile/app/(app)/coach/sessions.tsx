import { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl } from "react-native";
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
import { useAuth } from "../../../src/context/AuthContext";
import { useI18n } from "../../../src/context/I18nContext";
import { mergeStaffHomeAlerts, type HomePriorityAlertItem } from "../../../src/lib/homePriorityAlerts";
import { HomePriorityAlerts } from "../../../src/components/HomePriorityAlerts";

export default function CoachSessionsScreen() {
  const { profile } = useAuth();
  const { language, t } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [waitlistBySession, setWaitlistBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
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

    const { data, error } = await fetchStaffTrainingSessionsForCalendar();
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    const ids = list.map((s) => s.id);
    const signup = await fetchActiveSignupCountsBySession(ids);
    const waitlist = await fetchWaitlistCountsBySession(ids);
    setSignupBySession(signup);
    setWaitlistBySession(waitlist);
    setHomeAlerts(await mergeStaffHomeAlerts("coach", list, signup, waitlist, language));
    setRefreshSeq((n) => n + 1);

    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, [language]);

  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load])
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
        waitlistCount: waitlistBySession[s.id] ?? 0,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        showStaffSessionLabels: true,
        isHidden: !!s.is_hidden,
        isOpenForRegistration: s.is_open_for_registration,
        onPress: () => router.push(`/(app)/coach/session/${s.id}`),
      })),
    [rows, signupBySession, waitlistBySession]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.coachSessions") }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[theme.colors.cta]} />}
      >
        {showPriorityAlerts ? (
          <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md }}>
            <HomePriorityAlerts
              items={homeAlerts}
              dismissStorageUserId={dismissStorageUserId}
              onVisibleCountChange={setPriorityAlertsVisibleCount}
            />
          </View>
        ) : null}
        <StaffHomeOverview userId={profile?.user_id} sessions={rows} variant="coach" refreshSeq={refreshSeq} />
        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "לא נמצאו אימונים." : "No sessions found."}
          onDayPress={(iso) => setSheetDay(iso)}
        />
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="coach"
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
});
