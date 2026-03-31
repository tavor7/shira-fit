import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { router, useFocusEffect, type Href } from "expo-router";
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
  const [attending, setAttending] = useState<TrainingSessionWithTrainer[]>([]);
  const [attendingLoading, setAttendingLoading] = useState(true);
  const [participantMap, setParticipantMap] = useState<Record<string, string[]>>({});
  const [staffBirthdays, setStaffBirthdays] = useState<{ name: string; role: string }[]>([]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setNow(new Date());
  }, [refreshSeq]);

  const loadAttending = useCallback(async () => {
    if (!userId) {
      setAttending([]);
      setAttendingLoading(false);
      return;
    }
    setAttendingLoading(true);
    const { data, error } = await supabase
      .from("session_registrations")
      .select(
        `
        training_sessions!inner(
          id,
          session_date,
          start_time,
          coach_id,
          duration_minutes,
          max_participants,
          is_open_for_registration,
          trainer:profiles!coach_id(full_name)
        )
      `
      )
      .eq("user_id", userId)
      .eq("status", "active");

    if (error || !data) {
      setAttending([]);
      setAttendingLoading(false);
      return;
    }

    const at = new Date();
    const list: TrainingSessionWithTrainer[] = [];
    for (const row of data as unknown[]) {
      const r = row as { training_sessions: TrainingSessionWithTrainer | TrainingSessionWithTrainer[] | null };
      const raw = r.training_sessions;
      const s = Array.isArray(raw) ? raw[0] : raw;
      if (!s?.id) continue;
      if (hasSessionNotEnded(s.session_date, s.start_time, durMin(s), at) && isInNext7Days(s.session_date, s.start_time, at)) {
        list.push(s);
      }
    }
    list.sort(
      (a, b) =>
        sessionStartsAt(a.session_date, a.start_time).getTime() -
        sessionStartsAt(b.session_date, b.start_time).getTime()
    );
    setAttending(list);
    setAttendingLoading(false);
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      loadAttending();
    }, [loadAttending])
  );

  useEffect(() => {
    loadAttending();
  }, [loadAttending, refreshSeq]);

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
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("session_registrations")
        .select("session_id, profiles(full_name)")
        .in("session_id", ids)
        .eq("status", "active");
      const map: Record<string, string[]> = {};
      for (const id of ids) map[id] = [];
      for (const row of data ?? []) {
        const r = row as {
          session_id: string;
          profiles: { full_name: string } | { full_name: string }[] | null;
        };
        const sid = r.session_id;
        let name = "—";
        if (r.profiles) {
          const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
          name = p?.full_name ?? "—";
        }
        if (map[sid] !== undefined) map[sid].push(name);
      }
      if (!cancelled) setParticipantMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentTeaching?.id, nextTeaching?.id]);

  if (!userId) return null;

  function SessionLine({
    s,
    prefix,
    alignRight,
  }: {
    s: TrainingSessionWithTrainer;
    prefix?: string;
    alignRight?: boolean;
  }) {
    const label = `${s.session_date} · ${formatSessionTimeRange(s.start_time, durMin(s))}`;
    const trainer = s.trainer?.full_name ? ` · ${s.trainer.full_name}` : "";
    return (
      <Pressable
        style={({ pressed }) => [styles.line, pressed && styles.linePressed]}
        onPress={() => router.push(sessionPath(variant, s.id) as Href)}
      >
        <Text style={[styles.lineText, alignRight && styles.rtlText]}>
          {prefix ? `${prefix}: ` : ""}
          {label}
          {trainer}
        </Text>
      </Pressable>
    );
  }

  function ParticipantBlock({ sessionId, title }: { sessionId: string; title: string }) {
    const names = participantMap[sessionId] ?? [];
    return (
      <View style={styles.card}>
        <Text style={[styles.cardTitle, isRTL && styles.rtlText]}>{title}</Text>
        {names.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין הרשמות פעילות." : "No active registrations."}</Text>
        ) : (
          names.map((n, idx) => (
            <Text key={`${sessionId}-${idx}`} style={styles.participantName}>
              {n}
            </Text>
          ))
        )}
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
      <Text style={[styles.sectionTitle, isRTL && styles.rtlText]}>{language === "he" ? "הקרובים שלך" : "Your upcoming"}</Text>
      <Text style={[styles.sectionHint, isRTL && styles.rtlText]}>
        {language === "he"
          ? "אימונים שנרשמת אליהם ב-7 הימים הקרובים (כולל היום)."
          : "Sessions you’re signed up for in the next 7 days (today included)."}
      </Text>
      {attendingLoading ? (
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} />
      ) : attending.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין כרגע." : "None right now."}</Text>
      ) : (
        attending.map((s) => <SessionLine key={`a-${s.id}`} s={s} />)
      )}

      <Text style={[styles.sectionTitle, styles.sectionSpaced, isRTL && styles.rtlText]}>
        {language === "he" ? "אימונים שאתה מאמן" : "Sessions you’re training"}
      </Text>
      <Text style={[styles.sectionHint, isRTL && styles.rtlText]}>
        {language === "he"
          ? "כל האימונים שבהם אתה המאמן ב-7 הימים הקרובים (כולל היום)."
          : "All sessions where you’re the trainer in the next 7 days (today included)."}
      </Text>
      {teachingNotEnded.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין כרגע." : "None right now."}</Text>
      ) : (
        teachingNotEnded.map((s) => <SessionLine key={`t-${s.id}`} s={s} alignRight={isRTL} />)
      )}

      {(currentTeaching || nextTeaching) && (
        <>
          <Text style={[styles.sectionTitle, styles.sectionSpaced, isRTL && styles.rtlText]}>
            {language === "he" ? "אימון נוכחי והבא" : "Current & next training"}
          </Text>
          <Text style={[styles.sectionHint, isRTL && styles.rtlText]}>
            {language === "he"
              ? "המשתתפים מוצגים רק עבור האימון הנוכחי והאימון הבא שלך כמאמן."
              : "Participants are shown only for your current and next session as trainer."}
          </Text>
          {currentTeaching ? (
            <>
              <SessionLine s={currentTeaching} prefix={language === "he" ? "נוכחי" : "Current"} alignRight={isRTL} />
              <ParticipantBlock sessionId={currentTeaching.id} title={language === "he" ? "משתתפים (נוכחי)" : "Participants (current)"} />
            </>
          ) : null}
          {nextTeaching ? (
            <>
              <SessionLine s={nextTeaching} prefix={language === "he" ? "הבא" : "Next"} alignRight={isRTL} />
              <ParticipantBlock sessionId={nextTeaching.id} title={language === "he" ? "משתתפים (הבא)" : "Participants (next)"} />
            </>
          ) : null}
        </>
      )}
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
  loader: { marginVertical: theme.spacing.sm },
  line: {
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.sm,
    marginBottom: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  linePressed: { opacity: 0.85 },
  lineText: { fontSize: 15, color: theme.colors.text, fontWeight: "500" },
  card: {
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  participantName: { fontSize: 15, color: theme.colors.text, marginBottom: 4 },
});
