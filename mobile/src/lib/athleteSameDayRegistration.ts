import type { ShowAppAlertOptions } from "../context/AppAlertContext";
import type { LanguageCode } from "../i18n/translations";
import { formatISODateFullWithWeekdayAfter } from "./dateFormat";
import { formatSessionTimeRange } from "./sessionTime";
import { supabase } from "./supabase";

export type SameDaySessionBrief = {
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
};

export async function fetchSameDayActiveRegistrations(
  userId: string,
  sessionDate: string,
  excludeSessionId: string
): Promise<SameDaySessionBrief[]> {
  const { data, error } = await supabase
    .from("session_registrations")
    .select("session_id, training_sessions!inner(id, session_date, start_time, duration_minutes)")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("training_sessions.session_date", sessionDate);

  if (error || !data) return [];

  const out: SameDaySessionBrief[] = [];
  for (const row of data) {
    const sess = row.training_sessions as unknown as {
      id: string;
      session_date: string;
      start_time: string;
      duration_minutes: number | null;
    };
    if (!sess || sess.id === excludeSessionId) continue;
    out.push({
      session_id: sess.id,
      session_date: sess.session_date,
      start_time: sess.start_time,
      duration_minutes: sess.duration_minutes ?? 60,
    });
  }
  out.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return out;
}

export function formatSameDayTimesForConfirm(sessions: SameDaySessionBrief[], language: LanguageCode): string {
  return sessions
    .map((s) => formatSessionTimeRange(s.start_time, s.duration_minutes))
    .join(language === "he" ? " · " : ", ");
}

export function confirmSameDaySecondRegistration(
  showAlert: (opts: ShowAppAlertOptions) => void,
  opts: {
    t: (key: string) => string;
    language: LanguageCode;
    sessionDate: string;
    others: SameDaySessionBrief[];
  }
): Promise<boolean> {
  if (opts.others.length === 0) return Promise.resolve(true);

  const dateStr = formatISODateFullWithWeekdayAfter(opts.sessionDate, opts.language);
  const times = formatSameDayTimesForConfirm(opts.others, opts.language);
  const message = opts
    .t("athleteSession.sameDayConfirmMessage")
    .replace("{date}", dateStr)
    .replace("{times}", times);

  return new Promise((resolve) => {
    showAlert({
      title: opts.t("athleteSession.sameDayConfirmTitle"),
      message,
      actions: [
        { label: opts.t("common.cancel"), variant: "secondary", onPress: () => resolve(false) },
        { label: opts.t("athleteSession.sameDayConfirmYes"), variant: "primary", onPress: () => resolve(true) },
      ],
    });
  });
}
