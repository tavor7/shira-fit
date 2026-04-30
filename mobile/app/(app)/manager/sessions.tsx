import { useCallback, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Alert, Pressable, ActivityIndicator, Text, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
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
import { supabase } from "../../../src/lib/supabase";

export default function ManagerSessionsScreen() {
  const { profile } = useAuth();
  const { language } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [waitlistBySession, setWaitlistBySession] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [weekStartIso, setWeekStartIso] = useState<string>("");
  const [openWeekBusy, setOpenWeekBusy] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const { data, error } = await fetchStaffTrainingSessionsForCalendar();
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    const ids = list.map((s) => s.id);
    setSignupBySession(await fetchActiveSignupCountsBySession(ids));
    setWaitlistBySession(await fetchWaitlistCountsBySession(ids));
    setRefreshSeq((n) => n + 1);

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
        waitlistCount: waitlistBySession[s.id] ?? 0,
        accentColor: resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id),
        showStaffSessionLabels: true,
        isHidden: !!s.is_hidden,
        isOpenForRegistration: s.is_open_for_registration,
        onPress: () => router.push(`/(app)/manager/session/${s.id}`),
      })),
    [rows, signupBySession, waitlistBySession]
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
        if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
        else Alert.alert(language === "he" ? "שגיאה" : "Error", error.message);
        return;
      }
      if (!data?.ok) {
        const m = data?.error ?? "";
        if (Platform.OS === "web" && typeof window !== "undefined") window.alert(m);
        else Alert.alert(language === "he" ? "נכשל" : "Failed", m);
        return;
      }
      const doneMsg = language === "he" ? `נפתחו ${data.opened ?? 0} אימונים.` : `Opened ${data.opened ?? 0} sessions.`;
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(doneMsg);
      else Alert.alert(language === "he" ? "נפתח" : "Opened", doneMsg);
      load(true);
    };

    // RN Web: multi-button Alert often does not show — use native confirm.
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(`${title}\n\n${msg}`)) void run();
      return;
    }

    Alert.alert(title, msg, [
      { text: language === "he" ? "ביטול" : "Cancel", style: "cancel" },
      { text: language === "he" ? "פתיחה" : "Open", onPress: () => void run() },
    ]);
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[theme.colors.cta]} />}
      >
        <StaffHomeOverview userId={profile?.user_id} sessions={rows} variant="manager" refreshSeq={refreshSeq} />
        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "לא נמצאו אימונים." : "No sessions found."}
          onDayPress={(iso) => setSheetDay(iso)}
          onWeekChange={(startIso) => setWeekStartIso(startIso)}
        />
        {weekStartIso ? (
          <View style={styles.weekActions}>
            <Pressable
              style={({ pressed }) => [
                styles.openWeekBtn,
                pressed && { opacity: 0.9 },
                openWeekBusy && { opacity: 0.6 },
              ]}
              onPress={() => void openSelectedWeek()}
              disabled={openWeekBusy}
            >
              {openWeekBusy ? (
                <ActivityIndicator color={theme.colors.ctaText} />
              ) : (
                <Text style={styles.openWeekBtnTxt}>
                  {language === "he" ? "פתיחת הרשמה לשבוע המוצג" : "Open registration for shown week"}
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
      <DaySessionsSheet
        visible={sheetDay !== null}
        onClose={() => setSheetDay(null)}
        dateIso={sheetDay ?? ""}
        items={sheetItems}
        variant="manager"
        onAddSession={() => {
          const d = sheetDay;
          setSheetDay(null);
          if (d) router.push({ pathname: "/(app)/manager/create-session", params: { date: d } });
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
  weekActions: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.md },
  openWeekBtn: {
    backgroundColor: theme.colors.cta,
    borderRadius: theme.radius.full,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.cta,
  },
  openWeekBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", letterSpacing: 0.2 },
});
