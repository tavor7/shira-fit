import { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text, ActivityIndicator, Pressable } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import type { TrainingSessionWithTrainer } from "../../../src/types/database";
import { useAuth } from "../../../src/context/AuthContext";
import { useI18n } from "../../../src/context/I18nContext";
import { theme } from "../../../src/theme";
import { fetchStaffTrainingSessionsForCalendar } from "../../../src/lib/trainingSessionQueries";
import { fetchActiveSignupCountsBySession } from "../../../src/lib/sessionSignupCounts";
import { fetchWaitlistCountsBySession } from "../../../src/lib/waitlistCounts";
import { resolveTrainerAccentColor } from "../../../src/lib/trainerCalendarColor";
import { formatSessionTimeRange, sessionStartsAt } from "../../../src/lib/sessionTime";
import { SessionsWeekCalendar, type SessionsWeekItem } from "../../../src/components/SessionsWeekCalendar";
import { DaySessionsSheet } from "../../../src/components/DaySessionsSheet";
import { formatISODateLong } from "../../../src/lib/dateFormat";
import { supabase } from "../../../src/lib/supabase";

function inWeek(iso: string, weekStartIso: string, weekEndIso: string) {
  if (!weekStartIso || !weekEndIso) return true;
  return iso >= weekStartIso && iso <= weekEndIso;
}

type RosterEntry = { name: string; phone: string | null };

export default function ManagerRosterCalendarScreen() {
  const { profile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const [rows, setRows] = useState<TrainingSessionWithTrainer[]>([]);
  const [signupBySession, setSignupBySession] = useState<Record<string, number>>({});
  const [waitlistBySession, setWaitlistBySession] = useState<Record<string, number>>({});
  const [rosterBySession, setRosterBySession] = useState<Record<string, RosterEntry[]>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [namesLoading, setNamesLoading] = useState(false);
  const [weekStartIso, setWeekStartIso] = useState<string>("");
  const [weekEndIso, setWeekEndIso] = useState<string>("");
  const [groupMode, setGroupMode] = useState(false);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [notesBySession, setNotesBySession] = useState<Record<string, string>>({});

  const isManager = profile?.role === "manager";
  if (!isManager) return <Redirect href="/(app)/manager/sessions" />;

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const { data, error } = await fetchStaffTrainingSessionsForCalendar();
    const list = !error && data ? (data as TrainingSessionWithTrainer[]) : [];
    setRows(list);
    const ids = list.map((s) => s.id);
    setSignupBySession(await fetchActiveSignupCountsBySession(ids));
    setWaitlistBySession(await fetchWaitlistCountsBySession(ids));

    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load])
  );

  const filteredRows = useMemo(
    () => (groupMode ? rows.filter((s) => (s.max_participants ?? 0) > 6) : rows),
    [rows, groupMode]
  );

  const weekSessions = useMemo(() => {
    const filtered = filteredRows.filter((s) => inWeek(s.session_date, weekStartIso, weekEndIso));
    filtered.sort(
      (a, b) =>
        sessionStartsAt(a.session_date, a.start_time).getTime() -
        sessionStartsAt(b.session_date, b.start_time).getTime()
    );
    return filtered;
  }, [filteredRows, weekStartIso, weekEndIso]);

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      filteredRows.map((s) => {
        const accentColor = resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id);
        if (groupMode) {
          const roster = rosterBySession[s.id] ?? [];
          const c = signupBySession[s.id] ?? 0;
          const m = s.max_participants ?? 0;
          const badge = m > 0 ? `${c}/${m}` : `${c}`;
          const wl = waitlistBySession[s.id] ?? 0;
          const subtitle =
            roster.length > 0
              ? roster.map((r) => r.name).join(", ")
              : language === "he"
                ? "אין נרשמים"
                : "No registrations";
          return {
            key: s.id,
            session_date: s.session_date,
            start_time: s.start_time,
            timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
            timeBadgeText: badge,
            timeBadgeText2: m > 0 && c >= m && wl > 0 ? String(wl) : undefined,
            waitlistCount: wl,
            subtitle,
            subtitleUnclamped: true,
            accentColor,
            onPress: () => router.push(`/(app)/manager/session/${s.id}`),
          } satisfies SessionsWeekItem;
        }
        return {
          key: s.id,
          session_date: s.session_date,
          start_time: s.start_time,
          timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
          trainerName: s.trainer?.full_name ?? undefined,
          coachId: s.coach_id,
          signedUpCount: signupBySession[s.id] ?? 0,
          maxParticipants: s.max_participants,
          waitlistCount: waitlistBySession[s.id] ?? 0,
          accentColor,
          showStaffSessionLabels: true,
          isHidden: !!s.is_hidden,
          isOpenForRegistration: s.is_open_for_registration,
          onPress: () => router.push(`/(app)/manager/session/${s.id}`),
        } satisfies SessionsWeekItem;
      }),
    [filteredRows, signupBySession, waitlistBySession, groupMode, rosterBySession, language]
  );

  const grouped = useMemo(() => {
    const byDate: Record<string, TrainingSessionWithTrainer[]> = {};
    for (const s of weekSessions) (byDate[s.session_date] ??= []).push(s);
    const dates = Object.keys(byDate).sort();
    return dates.map((d) => ({
      date: d,
      title: formatISODateLong(d, language),
      items: byDate[d].sort(
        (a, b) =>
          sessionStartsAt(a.session_date, a.start_time).getTime() -
          sessionStartsAt(b.session_date, b.start_time).getTime()
      ),
    }));
  }, [weekSessions, language]);

  const sheetItems = useMemo(() => (sheetDay ? items.filter((i) => i.session_date === sheetDay) : []), [items, sheetDay]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = weekSessions.map((s) => s.id);
      if (ids.length === 0) {
        setRosterBySession({});
        setNotesBySession({});
        setNamesLoading(false);
        return;
      }
      setNamesLoading(true);
      const next: Record<string, RosterEntry[]> = {};
      for (const id of ids) next[id] = [];

      const [reg, man, notesRes] = await Promise.all([
        supabase
          .from("session_registrations")
          .select("session_id, profiles(full_name, phone)")
          .in("session_id", ids)
          .eq("status", "active"),
        supabase.from("session_manual_participants").select("session_id, manual_participants(full_name, phone)").in("session_id", ids),
        supabase.from("session_notes").select("session_id, body, created_at").in("session_id", ids).order("created_at"),
      ]);

      if (!reg.error) {
        for (const row of (reg.data as any[]) ?? []) {
          const session_id = String(row.session_id ?? "");
          const p = row.profiles ? (Array.isArray(row.profiles) ? row.profiles[0] : row.profiles) : null;
          const name = String(p?.full_name ?? "").trim();
          const phoneRaw = String(p?.phone ?? "").trim();
          const phone = phoneRaw.length > 0 ? phoneRaw : null;
          if (session_id && name && next[session_id]) next[session_id].push({ name, phone });
        }
      }

      if (!man.error) {
        for (const row of (man.data as any[]) ?? []) {
          const session_id = String(row.session_id ?? "");
          const p = row.manual_participants
            ? Array.isArray(row.manual_participants)
              ? row.manual_participants[0]
              : row.manual_participants
            : null;
          const name = String(p?.full_name ?? "").trim();
          const phoneRaw = String(p?.phone ?? "").trim();
          const phone = phoneRaw.length > 0 ? phoneRaw : null;
          if (session_id && name && next[session_id]) next[session_id].push({ name, phone });
        }
      }

      for (const id of Object.keys(next)) {
        next[id].sort((a, b) => a.name.localeCompare(b.name));
      }

      const notesMap: Record<string, string[]> = {};
      if (!notesRes.error && notesRes.data) {
        for (const row of notesRes.data as { session_id: string; body: string }[]) {
          const sid = String(row.session_id ?? "");
          const body = String(row.body ?? "").trim();
          if (!sid || !body) continue;
          (notesMap[sid] ??= []).push(body);
        }
      }
      const notesJoined: Record<string, string> = {};
      for (const sid of Object.keys(notesMap)) {
        notesJoined[sid] = notesMap[sid].join("\n");
      }

      if (!cancelled) {
        setRosterBySession(next);
        setNotesBySession(notesJoined);
        setNamesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weekSessions]);

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            colors={[theme.colors.cta]}
          />
        }
      >
        <View style={styles.headerRow}>
          <Text style={[styles.h1, isRTL && styles.rtlText]}>
            {language === "he" ? "יומן משתתפים (מנהל)" : "Roster calendar (manager)"}
          </Text>
          <Text style={[styles.hint, isRTL && styles.rtlText]}>
            {language === "he"
              ? "בחרו שבוע כדי לראות את רשימות המשתתפים לכל אימון."
              : "Pick a week to see the participant roster for each session."}
          </Text>
          <Pressable
            onPress={() => setGroupMode((v) => !v)}
            style={({ pressed }) => [
              styles.toggleRow,
              pressed && { opacity: 0.92 },
              groupMode && styles.toggleRowOn,
            ]}
          >
            <Text style={[styles.toggleTxt, groupMode && styles.toggleTxtOn]} numberOfLines={1}>
              {language === "he" ? "מצב קבוצות (מעל 6)" : "Groups mode (max > 6)"}
            </Text>
            <View style={[styles.togglePill, groupMode && styles.togglePillOn]}>
              <Text style={[styles.togglePillTxt, groupMode && styles.togglePillTxtOn]}>
                {groupMode ? t("common.on") : t("common.off")}
              </Text>
            </View>
          </Pressable>
        </View>

        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={language === "he" ? "לא נמצאו אימונים." : "No sessions found."}
          onDayPress={(iso) => setSheetDay(iso)}
          onWeekChange={(startIso, endIso) => {
            setWeekStartIso(startIso);
            setWeekEndIso(endIso);
          }}
        />

        <View style={styles.rosterHeader}>
          <Text style={[styles.rosterTitle, isRTL && styles.rtlText]}>
            {groupMode
              ? language === "he"
                ? "השמות מוצגים על גבי היומן"
                : "Names are shown on the calendar cards"
              : language === "he"
                ? "רשימות לשבוע המוצג"
                : "Rosters for shown week"}
          </Text>
          {groupMode && namesLoading ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
        </View>

        {!groupMode && grouped.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtlText]}>
            {language === "he" ? "אין אימונים בשבוע הזה." : "No sessions in this week."}
          </Text>
        ) : !groupMode ? (
          grouped.map((g) => (
            <View key={g.date} style={styles.dayGroup}>
              <Text style={[styles.dayTitle, isRTL && styles.rtlText]}>{g.title}</Text>
              <View style={styles.dayCards}>
                {g.items.map((s) => {
                  const accent = resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id);
                  const c = signupBySession[s.id] ?? 0;
                  const m = s.max_participants ?? 0;
                  const roster = rosterBySession[s.id] ?? [];
                  const noteText = notesBySession[s.id]?.trim() ?? "";
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => router.push(`/(app)/manager/session/${s.id}`)}
                      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
                    >
                      <View style={[styles.accent, accent ? { backgroundColor: accent } : null]} />
                      <View style={styles.cardBody}>
                        <View style={[styles.cardTop, isRTL && styles.cardTopRtl]}>
                          <Text style={[styles.time, isRTL && styles.rtlText]}>
                            {formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60)}
                          </Text>
                          <Text style={styles.count}>
                            {c} / {m}
                          </Text>
                        </View>
                        <Text style={[styles.trainer, isRTL && styles.rtlText]} numberOfLines={1}>
                          {s.trainer?.full_name ?? (language === "he" ? "ללא מאמן" : "No trainer")}
                        </Text>
                        {roster.length === 0 ? (
                          <Text style={[styles.namesEmpty, isRTL && styles.rtlText]}>
                            {language === "he" ? "אין נרשמים." : "No registrations."}
                          </Text>
                        ) : (
                          <View style={styles.namesList}>
                            {roster.map((r, idx) => (
                              <Text
                                key={`${s.id}:r:${idx}:${r.name}:${r.phone ?? ""}`}
                                style={[styles.name, isRTL && styles.rtlText]}
                                numberOfLines={2}
                              >
                                {r.name}
                                {r.phone ? (language === "he" ? ` · ${r.phone}` : ` · ${r.phone}`) : ""}
                              </Text>
                            ))}
                          </View>
                        )}
                        {noteText.length > 0 ? (
                          <View style={styles.notesBlock}>
                            <Text style={[styles.notesLabel, isRTL && styles.rtlText]}>
                              {language === "he" ? "הערות" : "Notes"}
                            </Text>
                            <Text style={[styles.notesBody, isRTL && styles.rtlText]}>{noteText}</Text>
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        ) : null}

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>

      <Pressable
        onPress={() => router.push("/(app)/manager/sessions")}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.backBtnTxt}>{language === "he" ? "חזרה ליומן" : "Back to calendar"}</Text>
      </Pressable>

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
        onChanged={() => void load(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 90 },
  rtlText: { textAlign: "right" },

  headerRow: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: 6 },
  h1: { color: theme.colors.text, fontWeight: "900", fontSize: 18 },
  hint: { color: theme.colors.textMuted, fontWeight: "700" },
  toggleRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  toggleRowOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surface },
  toggleTxt: { flex: 1, minWidth: 0, color: theme.colors.text, fontWeight: "900" },
  toggleTxtOn: { color: theme.colors.cta },
  togglePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  togglePillOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  togglePillTxt: { color: theme.colors.textMuted, fontWeight: "900", fontSize: 12, letterSpacing: 0.2 },
  togglePillTxtOn: { color: theme.colors.ctaText },

  rosterHeader: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rosterTitle: { color: theme.colors.text, fontWeight: "900", fontSize: 16 },
  muted: { paddingHorizontal: theme.spacing.md, color: theme.colors.textMuted, fontWeight: "700" },

  dayGroup: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.md },
  dayTitle: { color: theme.colors.textSoft, fontWeight: "900", fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase" },
  dayCards: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },

  card: {
    flexDirection: "row",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  accent: { width: 6, backgroundColor: theme.colors.borderMuted },
  cardBody: { flex: 1, padding: theme.spacing.md, gap: 6, minWidth: 0 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  cardTopRtl: { flexDirection: "row-reverse" },
  time: { color: theme.colors.text, fontWeight: "900", fontSize: 15 },
  count: { color: theme.colors.textMuted, fontWeight: "900", letterSpacing: 0.3 },
  trainer: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 13 },

  namesEmpty: { color: theme.colors.textSoft, fontWeight: "700", marginTop: 6 },
  namesList: { marginTop: 2, gap: 4 },
  name: { color: theme.colors.text, fontWeight: "700" },
  notesBlock: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderMuted },
  notesLabel: {
    color: theme.colors.textSoft,
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  notesBody: { color: theme.colors.textMuted, fontWeight: "600", fontSize: 13, lineHeight: 18 },

  backBtn: {
    position: "absolute",
    left: theme.spacing.md,
    right: theme.spacing.md,
    bottom: theme.spacing.md,
    backgroundColor: theme.colors.cta,
    borderRadius: theme.radius.full,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.cta,
  },
  backBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", letterSpacing: 0.2 },
});

