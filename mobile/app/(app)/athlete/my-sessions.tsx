import { useCallback, useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { formatSessionTimeRange } from "../../../src/lib/sessionTime";
import { useI18n } from "../../../src/context/I18nContext";

type TsNested = {
  id: string;
  session_date: string;
  start_time: string;
  duration_minutes?: number | null;
};

type Row = { session_id: string; training_sessions: TsNested };

export default function MySessionsScreen() {
  const { language } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);

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
      .select("id, session_date, start_time, duration_minutes")
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
          subtitle: language === "he" ? "נרשם" : "Registered",
          onPress: () => router.push(`/(app)/athlete/session/${ts.id}`),
        };
      }),
    [rows]
  );

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  return (
    <View style={styles.screen}>
      <SessionsWeekCalendar
        items={items}
        isLoading={loading}
        emptyLabel={language === "he" ? "אין הרשמות פעילות." : "No active registrations."}
        onDayPress={(iso) => setSheetDay(iso)}
      />
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
});
