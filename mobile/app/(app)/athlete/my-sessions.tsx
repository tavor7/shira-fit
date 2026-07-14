import { useCallback, useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { EmptyState } from "../../../src/components/EmptyState";
import { SessionCardSkeleton } from "../../../src/components/SessionCardSkeleton";
import { formatSessionTimeRange } from "../../../src/lib/sessionTime";
import { useI18n } from "../../../src/context/I18nContext";

type TsNested = {
  id: string;
  session_date: string;
  start_time: string;
  duration_minutes?: number | null;
  is_kickbox?: boolean | null;
};

type Row = { session_id: string; training_sessions: TsNested };

export default function MySessionsScreen() {
  const { t, isRTL } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const u = (await supabase.auth.getUser()).data.user?.id;
    if (!u) {
      setRows([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("session_registrations")
      .select("session_id")
      .eq("user_id", u)
      .eq("status", "active");

    const sessionIds = (data ?? []).map((r) => String((r as any).session_id)).filter(Boolean);
    if (sessionIds.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Fetch sessions separately so hidden sessions still appear for already-registered athletes,
    // even if the foreign-table join is affected by RLS filtering.
    const { data: sessData } = await supabase
      .from("training_sessions")
      .select("id, session_date, start_time, duration_minutes, is_kickbox")
      .in("id", sessionIds);
    const sessions = ((sessData as TsNested[]) ?? []).filter((x) => !!x?.id);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const list: Row[] = sessionIds.map((id) => {
      const ts = byId.get(id);
      return ts ? { session_id: id, training_sessions: ts } : null;
    }).filter((x): x is Row => x !== null);
    setRows(list);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      rows.map((r) => {
        const ts = r.training_sessions;
        const dm = ts.duration_minutes ?? 60;
        return {
          key: ts.id,
          session_date: ts.session_date,
          start_time: ts.start_time,
          durationMinutes: dm,
          timeLabel: formatSessionTimeRange(ts.start_time, dm),
          subtitle: t("athleteMySessions.registeredBadge"),
          athleteRegistered: true,
          isKickbox: !!ts.is_kickbox,
          onPress: () => router.push(`/(app)/athlete/session/${ts.id}`),
        };
      }),
    [rows, t]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  const hasRegistrations = rows.length > 0;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.athleteMySessions") }} />
      {loading ? (
        <View style={styles.loadingBox}>
          <SessionCardSkeleton />
          <SessionCardSkeleton />
          <SessionCardSkeleton />
        </View>
      ) : !hasRegistrations ? (
        <EmptyState
          title={t("empty.noActiveRegistrations")}
          body={t("athleteMySessions.emptyBody")}
          icon="📅"
          actionLabel={t("athleteMySessions.browseSessions")}
          onAction={() => router.push("/(app)/athlete/sessions")}
          isRTL={isRTL}
          style={styles.emptyPage}
        />
      ) : (
        <>
          <SessionsWeekCalendar
            items={items}
            isLoading={false}
            emptyLabel={t("empty.noSessionsWeek")}
            onDayPress={(iso) => setSheetDay(iso)}
            weekOffset={calendarWeekOffset}
            onWeekOffsetChange={setCalendarWeekOffset}
          />
          <DaySessionsSheet
            visible={sheetDay !== null}
            onClose={() => setSheetDay(null)}
            dateIso={sheetDay ?? ""}
            items={sheetItems}
            variant="athlete"
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  loadingBox: {
    flex: 1,
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
  },
  emptyPage: { flex: 1 },
});
