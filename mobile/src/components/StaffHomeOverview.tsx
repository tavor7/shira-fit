import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { router, type Href } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import type { TrainingSessionWithTrainer } from "../types/database";
import {
  formatSessionTimeRange,
  hasSessionNotEnded,
  isSessionInProgress,
  sessionStartsAt,
} from "../lib/sessionTime";
import { useI18n } from "../context/I18nContext";
import { isBirthdayToday } from "../lib/birthday";
import { formatISODateFull, formatISODateLong } from "../lib/dateFormat";
import { fetchActiveSignupCountsBySession } from "../lib/sessionSignupCounts";

function truncateNotePreview(body: string, maxLen: number): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

type Props = {
  userId: string | undefined;
  sessions: TrainingSessionWithTrainer[];
  variant: "coach" | "manager";
  refreshSeq: number;
};

function sessionPath(variant: "coach" | "manager", id: string) {
  return variant === "manager" ? `/(app)/manager/session/${id}` : `/(app)/coach/session/${id}`;
}

function durMin(s: TrainingSessionWithTrainer) {
  return s.duration_minutes ?? 60;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function isInNext7Days(sessionDate: string, startTime: string, now: Date) {
  const start = sessionStartsAt(sessionDate, startTime);
  const windowStart = startOfDay(now);
  // inclusive of today, up to (but not including) day 8
  const windowEndExclusive = addDays(windowStart, 8);
  return start.getTime() >= windowStart.getTime() && start.getTime() < windowEndExclusive.getTime();
}

export function StaffHomeOverview({ userId, sessions, variant, refreshSeq }: Props) {
  const { language, isRTL } = useI18n();
  const [now, setNow] = useState(() => new Date());
  const [participantMap, setParticipantMap] = useState<Record<string, string[]>>({});
  const [noteMap, setNoteMap] = useState<
    Record<string, { body: string; authorName: string; created_at: string } | null>
  >({});
  const [staffBirthdays, setStaffBirthdays] = useState<{ name: string; role: string }[]>([]);
  const [teachingSignupCounts, setTeachingSignupCounts] = useState<Record<string, number>>({});
  const [teachingNotePreview, setTeachingNotePreview] = useState<Record<string, string>>({});

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setNow(new Date());
  }, [refreshSeq]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, role, date_of_birth")
        .in("role", ["coach", "manager"])
        .order("full_name", { ascending: true });
      if (cancelled) return;
      if (error || !data) {
        setStaffBirthdays([]);
        return;
      }
      const today = new Date();
      const list = (data as any[])
        .map((r) => ({
          name: String(r.full_name ?? "").trim(),
          role: String(r.role ?? "").trim(),
          dob: (r.date_of_birth as string | null | undefined) ?? null,
        }))
        .filter((r) => r.name && isBirthdayToday(r.dob, today))
        .map((r) => ({ name: r.name, role: r.role }));
      setStaffBirthdays(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSeq]);

  const teachingNotEnded = useMemo(() => {
    if (!userId) return [];
    return sessions
      .filter(
        (s) =>
          s.coach_id === userId &&
          hasSessionNotEnded(s.session_date, s.start_time, durMin(s), now) &&
          isInNext7Days(s.session_date, s.start_time, now)
      )
      .sort(
        (a, b) =>
          sessionStartsAt(a.session_date, a.start_time).getTime() -
          sessionStartsAt(b.session_date, b.start_time).getTime()
      );
  }, [sessions, userId, now]);

  const teachingSessionIdsKey = useMemo(
    () =>
      teachingNotEnded
        .map((s) => s.id)
        .sort()
        .join(","),
    [teachingNotEnded]
  );

  useEffect(() => {
    const ids = teachingNotEnded.map((s) => s.id);
    if (ids.length === 0) {
      setTeachingSignupCounts({});
      setTeachingNotePreview({});
      return;
    }
    let cancelled = false;
    (async () => {
      const counts = await fetchActiveSignupCountsBySession(ids);
      const { data } = await supabase
        .from("session_notes")
        .select("session_id, body, created_at")
        .in("session_id", ids)
        .order("created_at", { ascending: false });
      const previews: Record<string, string> = {};
      for (const row of data ?? []) {
        const r = row as { session_id: string; body: string };
        if (previews[r.session_id]) continue;
        const body = String(r.body ?? "").trim();
        if (body.length > 0) previews[r.session_id] = truncateNotePreview(body, 96);
      }
      if (!cancelled) {
        setTeachingSignupCounts(counts);
        setTeachingNotePreview(previews);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teachingSessionIdsKey, refreshSeq]);

  const { currentTeaching, nextTeaching } = useMemo(() => {
    let current: TrainingSessionWithTrainer | null = null;
    for (const s of teachingNotEnded) {
      if (isSessionInProgress(s.session_date, s.start_time, durMin(s), now)) {
        current = s;
        break;
      }
    }
    const next =
      teachingNotEnded.find((s) => sessionStartsAt(s.session_date, s.start_time).getTime() > now.getTime()) ?? null;
    return { currentTeaching: current, nextTeaching: next };
  }, [teachingNotEnded, now]);

  useEffect(() => {
    const ids = [currentTeaching?.id, nextTeaching?.id].filter(Boolean) as string[];
    if (ids.length === 0) {
      setParticipantMap({});
      setNoteMap({});
      return;
    }
    let cancelled = false;
    (async () => {
      // Must match `active_registration_counts` / calendar capacity: include Quick Add
      // (`session_manual_participants`), not only `session_registrations`.
      const entries = await Promise.all(
        ids.map(async (sid) => {
          const { data, error } = await supabase.rpc("list_session_participants", { p_session_id: sid });
          if (error || !data) return [sid, [] as string[]] as const;
          const names = (data as { full_name: string }[])
            .map((r) => String(r.full_name ?? "").trim())
            .filter((n) => n.length > 0);
          return [sid, names] as const;
        })
      );
      if (cancelled) return;
      const map: Record<string, string[]> = {};
      for (const [sid, names] of entries) map[sid] = names;
      setParticipantMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentTeaching?.id, nextTeaching?.id]);

  useEffect(() => {
    const ids = [currentTeaching?.id, nextTeaching?.id].filter(Boolean) as string[];
    if (ids.length === 0) {
      setNoteMap({});
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("session_notes")
        .select("session_id, body, created_at, profiles(full_name)")
        .in("session_id", ids)
        .order("created_at", { ascending: false });

      const map: Record<string, { body: string; authorName: string; created_at: string } | null> = {};
      for (const id of ids) map[id] = null;
      for (const row of data ?? []) {
        const r = row as {
          session_id: string;
          body: string;
          created_at: string;
          profiles: { full_name: string } | { full_name: string }[] | null;
        };
        // Keep newest per session (query is sorted desc).
        if (map[r.session_id]) continue;
        const p = r.profiles ? (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles) : null;
        map[r.session_id] = {
          body: String(r.body ?? ""),
          authorName: String(p?.full_name ?? "—"),
          created_at: String(r.created_at ?? ""),
        };
      }
      if (!cancelled) setNoteMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentTeaching?.id, nextTeaching?.id]);

  if (!userId) return null;

  function TeachingSessionSummaryCard({
    s,
    prefix,
    participantTitle,
    notesTitle,
    alignRight,
    emphasis,
  }: {
    s: TrainingSessionWithTrainer;
    prefix: string;
    participantTitle: string;
    /** When set and a note exists for this session, show it inside this card below participants. */
    notesTitle?: string;
    alignRight?: boolean;
    emphasis: "current" | "next";
  }) {
    const names = participantMap[s.id] ?? [];
    const note = noteMap[s.id] ?? null;
    const label = `${formatISODateLong(s.session_date, language)} · ${formatSessionTimeRange(s.start_time, durMin(s))}`;
    const nameAlign = isRTL ? styles.participantNameRtlUi : styles.participantNameLtrUi;
    const isCurrent = emphasis === "current";
    return (
      <View
        style={[
          styles.teachingSessionCardBase,
          isCurrent ? styles.teachingSessionCardCurrent : styles.teachingSessionCardNext,
        ]}
      >
        {isCurrent ? (
          <View style={[styles.nowBadgeWrap, isRTL && styles.nowBadgeWrapRtl]}>
            <View style={styles.nowBadge}>
              <Text style={styles.nowBadgeText}>{language === "he" ? "עכשיו" : "Now"}</Text>
            </View>
          </View>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.sessionCardTimePress, pressed && styles.linePressed]}
          onPress={() => router.push(sessionPath(variant, s.id) as Href)}
        >
          <Text
            style={[
              styles.sessionCardTimeText,
              isCurrent && styles.sessionCardTimeTextCurrent,
              nameAlign,
              alignRight && styles.rtlText,
            ]}
          >
            {prefix ? `${prefix}: ` : ""}
            {label}
          </Text>
        </Pressable>
        <Text style={[styles.sessionCardParticipantHeading, isRTL && styles.rtlText]}>{participantTitle}</Text>
        {names.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין הרשמות פעילות." : "No active registrations."}</Text>
        ) : (
          names.map((n, idx) => (
            <Text key={`${s.id}-${idx}`} style={[styles.participantName, nameAlign]}>
              {n}
            </Text>
          ))
        )}
        {notesTitle && note?.body ? (
          <View style={styles.teachingCardNotesSection}>
            <Text style={[styles.sessionCardParticipantHeading, isRTL && styles.rtlText]}>{notesTitle}</Text>
            <Text style={[styles.noteMeta, isRTL && styles.rtlText]} numberOfLines={1}>
              {note.authorName} · {formatISODateFull(note.created_at.slice(0, 10), language)}
            </Text>
            <Text style={[styles.noteBody, isRTL && styles.rtlText]} numberOfLines={6}>
              {note.body}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  function GroupedSessionList({
    list,
    emptyText,
    alignRight,
    signupBySession,
    notePreviewBySession,
  }: {
    list: TrainingSessionWithTrainer[];
    emptyText: string;
    alignRight?: boolean;
    signupBySession: Record<string, number>;
    notePreviewBySession: Record<string, string>;
  }) {
    const groups = useMemo(() => {
      const byDate: Record<string, TrainingSessionWithTrainer[]> = {};
      for (const s of list) {
        (byDate[s.session_date] ??= []).push(s);
      }
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
    }, [list, language]);

    const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});

    useEffect(() => {
      // Default: collapsed (agenda view). User can expand a day to see sessions.
      const next: Record<string, boolean> = {};
      for (const g of groups) next[g.date] = false;
      setExpandedDates(next);
    }, [groups.map((g) => `${g.date}:${g.items.length}`).join("|")]);

    if (groups.length === 0) {
      return <Text style={[styles.muted, alignRight && styles.rtlText]}>{emptyText}</Text>;
    }

    return (
      <View style={styles.groupList}>
        {groups.map((g) => {
          const expanded = expandedDates[g.date] ?? false;
          return (
            <View key={g.date} style={styles.groupCard}>
              <Pressable
                onPress={() =>
                  setExpandedDates((m) => {
                    const next: Record<string, boolean> = {};
                    for (const key of Object.keys(m)) next[key] = false;
                    next[g.date] = !expanded;
                    return next;
                  })
                }
                style={({ pressed }) => [styles.groupHeader, pressed && styles.groupHeaderPressed]}
              >
                <Text style={[styles.groupTitle, alignRight && styles.rtlText]} numberOfLines={1}>
                  {g.title}
                </Text>
                <View style={styles.groupMeta}>
                  <View style={styles.countPill}>
                    <Text style={styles.countPillText}>{g.items.length}</Text>
                  </View>
                  <Text style={styles.chev}>{expanded ? "▲" : "▼"}</Text>
                </View>
              </Pressable>

              {expanded ? (
                <View style={styles.groupBody}>
                  {g.items.map((s) => {
                    const time = formatSessionTimeRange(s.start_time, durMin(s));
                    const signedUp = signupBySession[s.id] ?? 0;
                    const cap = s.max_participants ?? 0;
                    const notePv = notePreviewBySession[s.id];
                    const edgeStyle = alignRight ? styles.participantNameRtlUi : styles.participantNameLtrUi;
                    return (
                      <Pressable
                        key={s.id}
                        style={({ pressed }) => [styles.sessionRow, pressed && styles.sessionRowPressed]}
                        onPress={() => router.push(sessionPath(variant, s.id) as Href)}
                      >
                        <View style={[styles.sessionRowTop, alignRight && styles.sessionRowTopRtl]}>
                          <Text style={[styles.sessionTime, edgeStyle, alignRight && styles.rtlText]} numberOfLines={1}>
                            {time}
                          </Text>
                          <Text style={[styles.sessionCapacity, edgeStyle, alignRight && styles.rtlText]} numberOfLines={1}>
                            {signedUp}/{cap > 0 ? cap : "—"}
                          </Text>
                        </View>
                        {notePv ? (
                          <Text style={[styles.sessionNotePreview, edgeStyle]} numberOfLines={2}>
                            {language === "he" ? "הערה: " : "Note: "}
                            {notePv}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {staffBirthdays.length > 0 ? (
        <View style={styles.bdayCard}>
          <Text style={[styles.bdayText, isRTL && styles.rtlText]}>
            🎂{" "}
            {language === "he"
              ? `לצוות יש יום הולדת היום: ${staffBirthdays.map((p) => p.name).join(" · ")}`
              : `Staff birthdays today: ${staffBirthdays.map((p) => p.name).join(" · ")}`}
          </Text>
        </View>
      ) : null}

      {(currentTeaching || nextTeaching) && (
        <>
          <Text style={[styles.sectionTitle, isRTL && styles.rtlText]}>
            {language === "he" ? "אימון נוכחי והבא" : "Current & next training"}
          </Text>
          {currentTeaching ? (
            <>
              <TeachingSessionSummaryCard
                s={currentTeaching}
                prefix={language === "he" ? "נוכחי" : "Current"}
                participantTitle={language === "he" ? "משתתפים (נוכחי)" : "Participants (current)"}
                notesTitle={language === "he" ? "הערות (נוכחי)" : "Notes (current)"}
                alignRight={isRTL}
                emphasis="current"
              />
            </>
          ) : null}
          {nextTeaching ? (
            <>
              <TeachingSessionSummaryCard
                s={nextTeaching}
                prefix={language === "he" ? "הבא" : "Next"}
                participantTitle={language === "he" ? "משתתפים (הבא)" : "Participants (next)"}
                notesTitle={language === "he" ? "הערות (הבא)" : "Notes (next)"}
                alignRight={isRTL}
                emphasis="next"
              />
            </>
          ) : null}
        </>
      )}

      <Text style={[styles.sectionTitle, styles.sectionSpaced, isRTL && styles.rtlText]}>
        {language === "he" ? "אימונים שאתה מאמן" : "Sessions you’re training"}
      </Text>
      <GroupedSessionList
        list={teachingNotEnded}
        emptyText={language === "he" ? "אין" : "None"}
        alignRight={isRTL}
        signupBySession={teachingSignupCounts}
        notePreviewBySession={teachingNotePreview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  bdayCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: theme.spacing.md,
  },
  bdayText: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "700", lineHeight: 18 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: theme.colors.text },
  sectionHint: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4, marginBottom: theme.spacing.sm },
  sectionSpaced: { marginTop: theme.spacing.lg },
  muted: { fontSize: 14, color: theme.colors.textMuted, fontStyle: "italic" },
  rtlText: { textAlign: "right" },
  linePressed: { opacity: 0.85 },
  teachingSessionCardBase: {
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
  },
  /** Happening now — high visibility */
  teachingSessionCardCurrent: {
    backgroundColor: theme.colors.successBg,
    borderWidth: 2,
    borderColor: theme.colors.success,
  },
  /** Scheduled next — standard weight */
  teachingSessionCardNext: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  nowBadgeWrap: { marginBottom: theme.spacing.sm, alignItems: "flex-start" },
  nowBadgeWrapRtl: { alignItems: "flex-end" },
  nowBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  nowBadgeText: {
    color: theme.colors.success,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  sessionCardTimePress: {
    marginBottom: theme.spacing.sm,
  },
  sessionCardTimeText: { fontSize: 15, color: theme.colors.text, fontWeight: "600" },
  sessionCardTimeTextCurrent: { fontSize: 16, fontWeight: "800" },
  sessionCardParticipantHeading: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.sm,
  },
  teachingCardNotesSection: {
    marginTop: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  groupList: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },
  groupCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
  },
  groupHeaderPressed: { opacity: 0.92 },
  groupTitle: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "800", color: theme.colors.text },
  groupMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginLeft: 10 },
  countPill: {
    minWidth: 28,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  countPillText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "900" },
  chev: { color: theme.colors.textMuted, fontSize: 11, fontWeight: "900" },
  groupBody: { paddingHorizontal: 8, paddingBottom: 8 },
  sessionRow: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginTop: 8,
  },
  sessionRowPressed: { opacity: 0.9 },
  sessionRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    width: "100%",
  },
  sessionRowTopRtl: { flexDirection: "row-reverse" },
  sessionTime: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "800", color: theme.colors.text },
  sessionCapacity: { fontSize: 14, fontWeight: "800", color: theme.colors.textMuted },
  sessionNotePreview: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textSoft,
    width: "100%",
  },
  participantName: {
    fontSize: 15,
    color: theme.colors.text,
    marginBottom: 4,
    alignSelf: "stretch",
    width: "100%",
  },
  /** Force one edge per UI language so mixed Hebrew/Latin names don’t split to opposite sides. */
  participantNameLtrUi: { textAlign: "left", writingDirection: "ltr" },
  participantNameRtlUi: { textAlign: "right", writingDirection: "rtl" },
  noteMeta: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 6 },
  noteBody: { color: theme.colors.text, fontSize: 14, fontWeight: "700", lineHeight: 18 },
});
