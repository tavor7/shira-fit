import { supabase } from "./supabase";
import { sessionStartsAt } from "./sessionTime";
import type { StaffAthleteSearchHit } from "./staffAthleteSearch";

export type AthleteUpcomingSession = {
  sessionId: string;
  sessionDate: string;
  startTime: string;
  durationMinutes: number;
  coachName: string;
};

type SessionEmbed = {
  id: string;
  session_date: string;
  start_time: string;
  duration_minutes?: number | null;
  trainer: { full_name: string } | { full_name: string }[] | null;
};

function parseUpcomingRows(
  rows: Array<{ training_sessions: SessionEmbed | SessionEmbed[] }>
): AthleteUpcomingSession[] {
  const now = Date.now();
  const out: AthleteUpcomingSession[] = [];

  for (const r of rows) {
    const s = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
    if (!s?.id) continue;
    if (sessionStartsAt(s.session_date, s.start_time).getTime() <= now) continue;
    const tr = s.trainer;
    const coachName = tr ? (Array.isArray(tr) ? tr[0]?.full_name : tr.full_name) ?? "—" : "—";
    out.push({
      sessionId: s.id,
      sessionDate: s.session_date,
      startTime: s.start_time,
      durationMinutes: s.duration_minutes ?? 60,
      coachName,
    });
  }

  out.sort(
    (a, b) =>
      sessionStartsAt(a.sessionDate, a.startTime).getTime() - sessionStartsAt(b.sessionDate, b.startTime).getTime()
  );
  return out;
}

const SESSION_SELECT = `training_sessions!inner(
  id,
  session_date,
  start_time,
  duration_minutes,
  trainer:profiles!coach_id(full_name)
)`;

export async function fetchStaffUpcomingRegisteredSessions(target: StaffAthleteSearchHit): Promise<AthleteUpcomingSession[]> {
  if (target.kind === "app") {
    const { data, error } = await supabase
      .from("session_registrations")
      .select(SESSION_SELECT)
      .eq("user_id", target.id)
      .eq("status", "active");
    if (error || !data) return [];
    return parseUpcomingRows(data as Array<{ training_sessions: SessionEmbed | SessionEmbed[] }>);
  }

  const { data, error } = await supabase
    .from("session_manual_participants")
    .select(SESSION_SELECT)
    .eq("manual_participant_id", target.id);
  if (error || !data) return [];
  return parseUpcomingRows(data as Array<{ training_sessions: SessionEmbed | SessionEmbed[] }>);
}
