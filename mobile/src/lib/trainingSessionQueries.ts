import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";

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

/** Athlete browse: all non-hidden sessions (even if closed); retries if `is_hidden` or `calendar_color` is missing on DB. */
export async function fetchAthleteOpenSessionsForCalendar() {
  let res = await supabase
    .from("training_sessions")
    .select("*, trainer:profiles!coach_id(full_name, calendar_color)")
    .eq("is_hidden", false)
    .order("session_date")
    .order("start_time");
  if (res.error && isMissingColumnError(res.error.message, "is_hidden")) {
    res = await supabase
      .from("training_sessions")
      .select("*, trainer:profiles!coach_id(full_name, calendar_color)")
      .order("session_date")
      .order("start_time");
  }
  if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
    res = await supabase
      .from("training_sessions")
      .select("*, trainer:profiles!coach_id(full_name)")
      .eq("is_hidden", false)
      .order("session_date")
      .order("start_time");
    if (res.error && isMissingColumnError(res.error.message, "is_hidden")) {
      res = await supabase
        .from("training_sessions")
        .select("*, trainer:profiles!coach_id(full_name)")
        .order("session_date")
        .order("start_time");
    }
  }
  return res;
}
