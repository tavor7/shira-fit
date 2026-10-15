import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";
import { athleteBrowseWeekEnd } from "./studioWeek";
import { getCurrentUserId } from "./currentUser";
import { mergeAthleteCalendarSessions, type CalendarSessionRow, type RegisteredSessionRow } from "./athleteCalendarMerge";

const ATHLETE_SESSION_SELECT = "*, trainer:profiles!coach_id(full_name, calendar_color)";
const ATHLETE_SESSION_SELECT_NO_COLOR = "*, trainer:profiles!coach_id(full_name)";

function applyBrowseEndFilter<T extends { lte: (col: string, val: string) => T }>(query: T, end: string) {
  return query.lte("session_date", end);
}

/** Staff calendar: sessions with trainer name + optional calendar_color (retries if column missing). */
export async function fetchStaffTrainingSessionsForCalendar() {
  let res = await supabase
    .from("training_sessions")
    .select("*, trainer:profiles!coach_id(full_name, calendar_color)")
    .order("session_date")
    .order("start_time");
  if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
    res = await supabase
      .from("training_sessions")
      .select("*, trainer:profiles!coach_id(full_name)")
      .order("session_date")
      .order("start_time");
  }
  return res;
}

/**
 * Athlete browse: non-hidden sessions through end of next week (any past week allowed), plus hidden sessions the
 * athlete is actively registered in (RLS lets an athlete read exactly those).
 *
 * Performance Phase 1 / step 3: this used to put every registered session id into the request URL
 * (`or=(is_hidden.eq.false,id.in.(…))`), and the home screen then sent every calendar session id twice more. Those
 * lists grow every week; on 2026-10-15 production athletes already sent ~8.9 KB (median) to ~10.7 KB of query string,
 * and a stricter gateway rejected it with 414. Now two independent requests with fixed-size URLs, run in parallel:
 * the non-hidden sessions, and the athlete's own active registrations joined to their (hidden) sessions.
 * Same result set as before; ordered by date then start time, as before.
 *
 * `userId`: pass the already-known id to skip the session lookup; omitted = read it from the local session.
 */
export async function fetchAthleteOpenSessionsForCalendar(userId?: string | null) {
  const end = athleteBrowseWeekEnd();
  const me = userId === undefined ? await getCurrentUserId() : userId;

  const visible = (select: string) =>
    applyBrowseEndFilter(
      supabase.from("training_sessions").select(select).eq("is_hidden", false).order("session_date").order("start_time"),
      end
    );
  const registeredHidden = (select: string) =>
    supabase
      .from("session_registrations")
      .select(`training_sessions!inner(${select})`)
      .eq("user_id", me as string)
      .eq("status", "active")
      .eq("training_sessions.is_hidden", true)
      .lte("training_sessions.session_date", end);

  const run = async (select: string) => {
    const [vis, mine] = await Promise.all([visible(select), me ? registeredHidden(select) : Promise.resolve(null)]);
    return { vis, mine };
  };

  let { vis, mine } = await run(ATHLETE_SESSION_SELECT);
  if ((vis.error && isMissingColumnError(vis.error.message, "calendar_color")) || (mine?.error && isMissingColumnError(mine.error.message, "calendar_color"))) {
    ({ vis, mine } = await run(ATHLETE_SESSION_SELECT_NO_COLOR));
  }
  if (vis.error && isMissingColumnError(vis.error.message, "is_hidden")) {
    // Legacy schema without hidden sessions: every session up to the browse end.
    return applyBrowseEndFilter(
      supabase.from("training_sessions").select(ATHLETE_SESSION_SELECT_NO_COLOR).order("session_date").order("start_time"),
      end
    );
  }
  if (vis.error) return { data: null, error: vis.error };
  if (mine?.error) return { data: null, error: mine.error };

  const data = mergeAthleteCalendarSessions(
    vis.data as unknown as CalendarSessionRow[],
    mine?.data as unknown as RegisteredSessionRow<CalendarSessionRow>[] | undefined
  );
  return { data, error: null };
}
