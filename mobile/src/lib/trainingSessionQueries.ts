import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";
import { athleteBrowseWeekEnd } from "./studioWeek";

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

/** Athlete browse: non-hidden sessions through end of next week (any past week allowed). */
export async function fetchAthleteOpenSessionsForCalendar() {
  const end = athleteBrowseWeekEnd();

  const me = (await supabase.auth.getUser()).data.user?.id ?? null;
  let visibleSessionIds: string[] = [];
  if (me) {
    const regs = await supabase
      .from("session_registrations")
      .select("session_id")
      .eq("user_id", me)
      .eq("status", "active");
    visibleSessionIds = ((regs.data as { session_id: string }[] | null) ?? []).map((r) => r.session_id);
  }

  let res =
    visibleSessionIds.length > 0
      ? await applyBrowseEndFilter(
          supabase
            .from("training_sessions")
            .select(ATHLETE_SESSION_SELECT)
            .or(`is_hidden.eq.false,id.in.(${visibleSessionIds.join(",")})`)
            .order("session_date")
            .order("start_time"),
          end
        )
      : await applyBrowseEndFilter(
          supabase
            .from("training_sessions")
            .select(ATHLETE_SESSION_SELECT)
            .eq("is_hidden", false)
            .order("session_date")
            .order("start_time"),
          end
        );

  if (res.error && isMissingColumnError(res.error.message, "is_hidden")) {
    res = await applyBrowseEndFilter(
      supabase.from("training_sessions").select(ATHLETE_SESSION_SELECT).order("session_date").order("start_time"),
      end
    );
  }
  if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
    let fallback =
      visibleSessionIds.length > 0
        ? await applyBrowseEndFilter(
            supabase
              .from("training_sessions")
              .select(ATHLETE_SESSION_SELECT_NO_COLOR)
              .or(`is_hidden.eq.false,id.in.(${visibleSessionIds.join(",")})`)
              .order("session_date")
              .order("start_time"),
            end
          )
        : await applyBrowseEndFilter(
            supabase
              .from("training_sessions")
              .select(ATHLETE_SESSION_SELECT_NO_COLOR)
              .eq("is_hidden", false)
              .order("session_date")
              .order("start_time"),
            end
          );
    if (fallback.error && isMissingColumnError(fallback.error.message, "is_hidden")) {
      fallback = await applyBrowseEndFilter(
        supabase.from("training_sessions").select(ATHLETE_SESSION_SELECT_NO_COLOR).order("session_date").order("start_time"),
        end
      );
    }
    res = fallback;
  }

  return res;
}
