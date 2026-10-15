import { useCallback, useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { router, useFocusEffect, Stack } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { useScreenContentStyle } from "../../../src/hooks/useScreenLayout";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { EmptyState } from "../../../src/components/EmptyState";
import { SessionCardSkeleton } from "../../../src/components/SessionCardSkeleton";

import { useI18n } from "../../../src/context/I18nContext";
import { CrossfadeSwap } from "../../../src/components/CrossfadeSwap";
import { displayTimeRange } from "../../../src/lib/displayFormat";
import { usePerfScreen } from "../../../src/hooks/usePerfScreen";
import { getCurrentUserId } from "../../../src/lib/currentUser";

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
  const calendarFrame = useScreenContentStyle("wide", { selfInset: theme.spacing.md });
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  usePerfScreen("athlete.mySessions", !loading);
  const [loadError, setLoadError] = useState(false);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const u = await getCurrentUserId();
    if (!u) {
      setRows([]);
      setLoading(false);
      return;
    }
    // One request: the athlete's active registrations joined to their sessions (Performance Phase 1 / step 3). It used to
    // put every registered session id into the URL, a list that grows with the athlete's history. RLS lets an athlete
    // read every session they are actively registered in, hidden ones included (verified: same rows as the old two-step
    // query for 40 synthetic athletes, 440 hidden registered sessions; docs/performance/harness/verify-athlete-queries.mjs).
    const { data, error } = await supabase
      .from("session_registrations")
      .select("session_id, training_sessions!inner(id, session_date, start_time, duration_minutes, is_kickbox)")
      .eq("user_id", u)
      .eq("status", "active");

    if (error) {
      setRows([]);
      setLoadError(true);
      setLoading(false);
      return;
    }

    const list: Row[] = [];
    for (const r of (data ?? []) as unknown as { session_id: string; training_sessions: TsNested | TsNested[] | null }[]) {
      const ts = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
      if (ts?.id) list.push({ session_id: String(r.session_id), training_sessions: ts });
    }
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
          timeLabel: displayTimeRange(ts.start_time, dm),
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
      <CrossfadeSwap
        loading={loading}
        skeleton={
          <View style={styles.loadingBox}>
            <SessionCardSkeleton />
            <SessionCardSkeleton />
            <SessionCardSkeleton />
          </View>
        }
      >
        {loadError ? (
          <EmptyState
            title={t("athleteMySessions.loadErrorTitle")}
            body={t("athleteMySessions.loadErrorBody")}
            tone="error"
            actionLabel={t("athleteMySessions.retry")}
            onAction={() => void load()}
            isRTL={isRTL}
            style={styles.emptyPage}
          />
        ) : !hasRegistrations ? (
          <EmptyState
            title={t("empty.noActiveRegistrations")}
            body={t("athleteMySessions.emptyBody")}
            icon="calendar-outline"
            actionLabel={t("athleteMySessions.browseSessions")}
            onAction={() => router.push("/(app)/athlete/sessions")}
            isRTL={isRTL}
            style={styles.emptyPage}
          />
        ) : (
          <>
            <View style={[styles.calendarWrap, calendarFrame]}>
              <SessionsWeekCalendar
                items={items}
                isLoading={false}
                emptyLabel={t("empty.noSessionsWeek")}
                onDayPress={(iso) => setSheetDay(iso)}
                weekOffset={calendarWeekOffset}
                onWeekOffsetChange={setCalendarWeekOffset}
              />
            </View>
            <DaySessionsSheet
              visible={sheetDay !== null}
              onClose={() => setSheetDay(null)}
              dateIso={sheetDay ?? ""}
              items={sheetItems}
              variant="athlete"
            />
          </>
        )}
      </CrossfadeSwap>
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
  calendarWrap: { flex: 1 },
});
