import { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text, ActivityIndicator, Pressable } from "react-native";
import { Redirect, router, useFocusEffect, Stack } from "expo-router";
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
import { fetchRegistrationAthletesBySessionIds } from "../../../src/lib/sessionRosterQueries";
import { formatISODateLong } from "../../../src/lib/dateFormat";
import { supabase } from "../../../src/lib/supabase";
import { touchWeeklyRegistrationOpenIfDue } from "../../../src/lib/touchWeeklyRegistrationOpen";
import { logRedirectToManagerSessions } from "../../../src/lib/managerSessionsRedirectLog";
import { isSessionInActiveSeries } from "../../../src/lib/sessionSeries";
import { EmptyState } from "../../../src/components/EmptyState";

function inWeek(iso: string, weekStartIso: string, weekEndIso: string) {
  if (!weekStartIso || !weekEndIso) return true;
  return iso >= weekStartIso && iso <= weekEndIso;
}

type RosterEntry = { name: string; phone: string | null };

export default function ManagerRosterCalendarScreen() {
  const { profile, loading: authLoading, user } = useAuth();
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
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [showSmall, setShowSmall] = useState(false);
  const [showBig, setShowBig] = useState(false);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [notesBySession, setNotesBySession] = useState<Record<string, string>>({});

  if (authLoading || (user && !profile)) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  }
  if (profile && profile.role !== "manager") {
    logRedirectToManagerSessions("app/(app)/manager/roster-calendar.tsx", "roster_calendar_wrong_role", {
      authLoading,
      authUserId: user?.id ?? null,
      profileRole: profile.role,
    });
    return <Redirect href="/(app)/manager/sessions" />;
  }

  const groupMode = showBig && !showSmall;
  const filtersOn = showSmall || showBig;

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    await touchWeeklyRegistrationOpenIfDue();
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

  const filteredRows = useMemo(() => {
    if (!showSmall && !showBig) return rows; // regular calendar
    if (showSmall && showBig) return rows; // both toggles on
    if (showBig) return rows.filter((s) => (s.max_participants ?? 0) > 6);
    return rows.filter((s) => (s.max_participants ?? 0) <= 6);
  }, [rows, showSmall, showBig]);

  const weekSessionsAll = useMemo(() => {
    const filtered = rows.filter((s) => inWeek(s.session_date, weekStartIso, weekEndIso));
    filtered.sort(
      (a, b) =>
        sessionStartsAt(a.session_date, a.start_time).getTime() -
        sessionStartsAt(b.session_date, b.start_time).getTime()
    );
    return filtered;
  }, [rows, weekStartIso, weekEndIso]);

  const weekSessions = useMemo(() => {
    const filtered = filteredRows.filter((s) => inWeek(s.session_date, weekStartIso, weekEndIso));
    filtered.sort(
      (a, b) =>
        sessionStartsAt(a.session_date, a.start_time).getTime() -
        sessionStartsAt(b.session_date, b.start_time).getTime()
    );
    return filtered;
  }, [filteredRows, weekStartIso, weekEndIso]);

  const smallWeekSessions = useMemo(
    () => weekSessionsAll.filter((s) => (s.max_participants ?? 0) <= 6),
    [weekSessionsAll]
  );

  const items = useMemo<SessionsWeekItem[]>(
    () =>
      filteredRows.map((s) => {
        const accentColor = resolveTrainerAccentColor(s.trainer?.calendar_color, s.coach_id);
        const isBig = (s.max_participants ?? 0) > 6;
        // When a filter is enabled, show roster names on the calendar cards for that group size.
        if ((showBig && isBig) || (showSmall && !isBig)) {
          const roster = rosterBySession[s.id] ?? [];
          const c = signupBySession[s.id] ?? 0;
          const m = s.max_participants ?? 0;
          const badge = m > 0 ? `${c}/${m}` : `${c}`;
          const wl = waitlistBySession[s.id] ?? 0;
          const subtitle =
            roster.length > 0
              ? roster.map((r) => r.name).join(", ")
              : t("empty.noRegistrations");
          return {
            key: s.id,
            session_date: s.session_date,
            start_time: s.start_time,
            durationMinutes: s.duration_minutes ?? 60,
            timeLabel: formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60),
            timeBadgeText: badge,
            timeBadgeText2: m > 0 && c >= m && wl > 0 ? String(wl) : undefined,
            waitlistCount: wl,
            trainerName: s.trainer?.full_name ?? undefined,
            subtitle,
            subtitleUnclamped: true,
            accentColor,
            hideTemporalDimming: filtersOn,
            hideRegistrationState: filtersOn,
            isKickbox: !!s.is_kickbox,
            isRecurringSeries: isSessionInActiveSeries(s),
            onPress: () => router.push(`/(app)/manager/session/${s.id}`),
          } satisfies SessionsWeekItem;
        }
        return {
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
          accentColor,
          showStaffSessionLabels: true,
          isHidden: !!s.is_hidden,
          isOpenForRegistration: s.is_open_for_registration,
          hideTemporalDimming: filtersOn,
          hideRegistrationState: filtersOn,
          isKickbox: !!s.is_kickbox,
          isRecurringSeries: isSessionInActiveSeries(s),
          onPress: () => router.push(`/(app)/manager/session/${s.id}`),
        } satisfies SessionsWeekItem;
      }),
    [filteredRows, signupBySession, waitlistBySession, showBig, showSmall, rosterBySession, t, filtersOn]
  );

  const itemsAll = useMemo<SessionsWeekItem[]>(
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
        hideTemporalDimming: filtersOn,
        hideRegistrationState: filtersOn,
        isKickbox: !!s.is_kickbox,
        isRecurringSeries: isSessionInActiveSeries(s),
        onPress: () => router.push(`/(app)/manager/session/${s.id}`),
      })),
    [rows, signupBySession, waitlistBySession, filtersOn]
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

  const smallGrouped = useMemo(() => {
    const byDate: Record<string, TrainingSessionWithTrainer[]> = {};
    for (const s of smallWeekSessions) (byDate[s.session_date] ??= []).push(s);
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
  }, [smallWeekSessions, language]);

  const sheetItems = useMemo(
    () => (sheetDay ? (groupMode ? itemsAll : items).filter((i) => i.session_date === sheetDay) : []),
    [items, itemsAll, sheetDay, groupMode]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = weekSessionsAll.map((s) => s.id);
      if (ids.length === 0) {
        setRosterBySession({});
        setNotesBySession({});
        setNamesLoading(false);
        return;
      }
      setNamesLoading(true);
      const next: Record<string, RosterEntry[]> = {};
      for (const id of ids) next[id] = [];

      const [regBatch, man, notesRes] = await Promise.all([
        fetchRegistrationAthletesBySessionIds(ids),
        supabase.from("session_manual_participants").select("session_id, manual_participants(full_name, phone)").in("session_id", ids),
        supabase.from("session_notes").select("session_id, body, created_at").in("session_id", ids).order("created_at"),
      ]);

      if (!regBatch.error) {
        for (const [session_id, entries] of Object.entries(regBatch.bySession)) {
          if (next[session_id]) next[session_id].push(...entries);
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
  }, [weekSessionsAll]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.managerRosterCalendar") }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={theme.colors.cta}
            colors={[theme.colors.cta]}
          />
        }
      >
        <View style={styles.headerRow}>
          <Text style={[styles.h1, isRTL && styles.rtlText]}>{t("rosterCalendar.title")}</Text>
          <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("rosterCalendar.hint")}</Text>
          <View style={[styles.modeWrap, isRTL && styles.modeWrapRtl]}>
            <Pressable
              onPress={() => setShowSmall((v) => !v)}
              style={({ pressed }) => [
                styles.filterBtn,
                showSmall && styles.filterBtnOn,
                pressed && !showSmall && styles.filterBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: showSmall }}
              accessibilityLabel={t("rosterCalendar.filterSmallA11y")}
            >
              <Text style={[styles.filterTxt, showSmall && styles.filterTxtOn]} numberOfLines={1}>
                {t("rosterCalendar.filterSmall")}
              </Text>
              <View style={[styles.filterPill, showSmall && styles.filterPillOn]}>
                <Text style={[styles.filterPillTxt, showSmall && styles.filterPillTxtOn]}>
                  {showSmall ? t("common.on") : t("common.off")}
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => setShowBig((v) => !v)}
              style={({ pressed }) => [
                styles.filterBtn,
                showBig && styles.filterBtnOn,
                pressed && !showBig && styles.filterBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: showBig }}
              accessibilityLabel={t("rosterCalendar.filterBigA11y")}
            >
              <Text style={[styles.filterTxt, showBig && styles.filterTxtOn]} numberOfLines={1}>
                {t("rosterCalendar.filterBig")}
              </Text>
              <View style={[styles.filterPill, showBig && styles.filterPillOn]}>
                <Text style={[styles.filterPillTxt, showBig && styles.filterPillTxtOn]}>
                  {showBig ? t("common.on") : t("common.off")}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>

        <SessionsWeekCalendar
          items={items}
          isLoading={loading}
          emptyLabel={t("empty.noSessionsFound")}
          onDayPress={(iso) => setSheetDay(iso)}
          weekOffset={calendarWeekOffset}
          onWeekOffsetChange={setCalendarWeekOffset}
          onWeekChange={(startIso, endIso) => {
            setWeekStartIso(startIso);
            setWeekEndIso(endIso);
          }}
        />

        <View style={styles.rosterHeader}>
          <Text style={[styles.rosterTitle, isRTL && styles.rtlText]}>
            {groupMode
              ? t("rosterCalendar.namesOnCalendar")
              : t("rosterCalendar.rostersForWeek")}
          </Text>
          {groupMode && namesLoading ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
        </View>

        {!groupMode && grouped.length === 0 ? (
          <EmptyState title={t("empty.noSessionsWeek")} isRTL={isRTL} style={styles.rosterEmpty} />
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
                      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
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
                          {s.trainer?.full_name ?? t("rosterCalendar.noTrainer")}
                        </Text>
                        {roster.length === 0 ? (
                          <Text style={[styles.namesEmpty, isRTL && styles.rtlText]}>
                            {t("empty.noRegistrations")}
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
                              {t("rosterCalendar.notes")}
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

        <View style={styles.scrollBottomSpacer} />
      </ScrollView>

      <Pressable
        onPress={() => router.push("/(app)/manager/sessions")}
        style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
      >
        <Text style={styles.backBtnTxt}>{t("rosterCalendar.backToCalendar")}</Text>
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
  scrollContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing.lg * 3 + theme.spacing.sm + theme.spacing.xs,
  },
  scrollBottomSpacer: { height: theme.spacing.xl },
  rtlText: { textAlign: "right" },

  headerRow: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: theme.spacing.xs },
  h1: {
    color: theme.colors.text,
    fontWeight: "800",
    fontSize: 22,
    letterSpacing: 0.2,
    lineHeight: 26,
  },
  hint: {
    marginTop: theme.spacing.sm,
    color: theme.colors.textMuted,
    fontWeight: "500",
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.15,
  },
  modeWrap: {
    marginTop: theme.spacing.sm,
    flexDirection: "row",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.full,
    padding: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignSelf: "stretch",
  },
  modeWrapRtl: { flexDirection: "row-reverse" },
  filterBtn: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 140,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "space-between",
    flexDirection: "row",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  filterBtnOn: { backgroundColor: theme.colors.surface, borderColor: theme.colors.cta },
  filterBtnPressed: { opacity: 0.92 },
  filterTxt: {
    flex: 1,
    minWidth: 0,
    fontWeight: "800",
    fontSize: 12,
    color: theme.colors.textMuted,
    letterSpacing: 0.15,
    lineHeight: 16,
  },
  filterTxtOn: { color: theme.colors.cta },
  filterPill: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  filterPillOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  filterPillTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 12, letterSpacing: 0.15 },
  filterPillTxtOn: { color: theme.colors.ctaText },

  rosterHeader: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  rosterTitle: {
    color: theme.colors.text,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0.15,
    lineHeight: 22,
    flexShrink: 1,
  },
  rosterEmpty: { paddingHorizontal: theme.spacing.md },
  muted: {
    paddingHorizontal: theme.spacing.md,
    color: theme.colors.textMuted,
    fontWeight: "600",
    fontSize: 15,
    lineHeight: 22,
  },

  dayGroup: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.md },
  dayTitle: {
    color: theme.colors.textSoft,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  dayCards: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },

  card: {
    flexDirection: "row",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  cardPressed: { opacity: 0.92 },
  accent: { width: theme.spacing.xs, backgroundColor: theme.colors.borderMuted },
  cardBody: { flex: 1, padding: theme.spacing.md, gap: theme.spacing.xs, minWidth: 0 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm },
  cardTopRtl: { flexDirection: "row-reverse" },
  time: {
    color: theme.colors.text,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.15,
    lineHeight: 20,
  },
  count: { color: theme.colors.textMuted, fontWeight: "800", letterSpacing: 0.15 },
  trainer: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 13, letterSpacing: 0.1 },

  namesEmpty: { color: theme.colors.textSoft, fontWeight: "600", marginTop: theme.spacing.xs, fontSize: 14 },
  namesList: { marginTop: theme.spacing.xs, gap: theme.spacing.xs },
  name: { color: theme.colors.text, fontWeight: "700", fontSize: 14, lineHeight: 20 },
  notesBlock: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  notesLabel: {
    color: theme.colors.textSoft,
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: theme.spacing.xs,
  },
  notesBody: { color: theme.colors.textMuted, fontWeight: "600", fontSize: 13, lineHeight: 18 },

  backBtn: {
    position: "absolute",
    left: theme.spacing.md,
    right: theme.spacing.md,
    bottom: theme.spacing.md,
    backgroundColor: theme.colors.cta,
    borderRadius: theme.radius.full,
    paddingVertical: theme.spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.cta,
  },
  backBtnPressed: { opacity: 0.9 },
  backBtnTxt: { color: theme.colors.ctaText, fontWeight: "800", letterSpacing: 0.15, fontSize: 15 },
});

