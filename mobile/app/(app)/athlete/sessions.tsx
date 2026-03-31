import { useCallback, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl } from "react-native";
import { router, useFocusEffect } from "expo-router";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";
import { formatSessionTimeRange } from "../../../src/lib/sessionTime";
import { fetchAthleteOpenSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { ActionButton } from "../../../src/components/ActionButton";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { useI18n } from "../../../src/context/I18nContext";

export default function AthleteSessionsScreen() {
  const { language } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    const { data, error } = await fetchAthleteOpenSessionsForCalendar();
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    setSignupBySession(await fetchActiveSignupCountsBySession(list.map((s) => s.id)));
    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, []);

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
        timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
        trainerName: s.trainer?.full_name ?? undefined,
        coachId: s.coach_id,
        signedUpCount: signupBySession[s.id] ?? 0,
        maxParticipants: s.max_participants,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        onPress: () => router.push(`/(app)/athlete/session/${s.id}`),
      })),
    [rows, signupBySession]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  return (
    <View style={styles.screen}>
      <View style={styles.topRow}>
        <ActionButton label={language === "he" ? "האימונים שלי" : "My sessions"} onPress={() => router.push("/(app)/athlete/my-sessions")} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[theme.colors.cta]} />}
      >
        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "אין אימונים פתוחים עדיין (חמישי 08:00 פותח את שבוע הבא)." : "No sessions open yet (Thu 08:00 opens next week)."}
          onDayPress={(iso) => setSheetDay(iso)}
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
  topRow: { padding: theme.spacing.md, paddingBottom: theme.spacing.sm },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, flex: 1, justifyContent: "center" },
});
