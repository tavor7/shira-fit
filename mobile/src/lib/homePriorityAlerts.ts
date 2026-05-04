import type { Href } from "expo-router";
import { supabase } from "./supabase";
import type { TrainingSessionWithTrainer } from "../types/database";
import { hasSessionNotEnded, sessionStartsAt, formatSessionTimeRange, formatSessionStartTime } from "./sessionTime";
import { fetchActiveSignupCountsBySession } from "./sessionSignupCounts";
import type { LanguageCode } from "../i18n/translations";
import { translations } from "../i18n/translations";
import { formatISODateDayMonth, formatISODateDayMonthWithWeekday, formatISODateFull } from "./dateFormat";
import { isRtlScript } from "./bidiEmbed";

function tr(lang: LanguageCode, key: string, params?: Record<string, string | number>): string {
  let s = translations[lang][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** Explicit BiDi per chunk — nested Text in UI when set (fixes Hebrew names in English sentences). */
export type HomePriorityLabelSegment = {
  text: string;
  dir: "ltr" | "rtl";
  /** Muted “subject” line vs main notification body */
  role?: "subject" | "body";
};

export type HomePriorityAlertItem = {
  id: string;
  /** Plain string fallback / accessibility; join of segments when segments exist */
  label: string;
  href: Href;
  labelSegments?: HomePriorityLabelSegment[];
  /** Late cancellation: cancelled within the last hour */
  isNew?: boolean;
};

export type RegistrationBannerState = {
  show_registration_countdown: boolean;
  show_registration_still_pending: boolean;
  next_open_at_utc: string;
  eligible_next_week_count: number;
  /** Sunday date (ISO) of the week used for stable dismiss id on “pending” registration alert. */
  current_unlock_week_start?: string;
};

function staffSessionPath(variant: "coach" | "manager", id: string): Href {
  return (variant === "manager" ? `/(app)/manager/session/${id}` : `/(app)/coach/session/${id}`) as Href;
}

const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_1H = 60 * 60 * 1000;

/**
 * Upcoming staff sessions with waitlist > 0 and at least one free spot; session not ended.
 */
export function buildStaffWaitlistFreeSpotItems(
  sessions: TrainingSessionWithTrainer[],
  signupBySession: Record<string, number>,
  waitlistBySession: Record<string, number>,
  variant: "coach" | "manager",
  language: LanguageCode,
  now = new Date()
): HomePriorityAlertItem[] {
  const rows: { session: TrainingSessionWithTrainer; label: string }[] = [];
  for (const s of sessions) {
    const w = waitlistBySession[s.id] ?? 0;
    if (w <= 0) continue;
    const filled = signupBySession[s.id] ?? 0;
    if (filled >= s.max_participants) continue;
    const dur = s.duration_minutes ?? 60;
    if (!hasSessionNotEnded(s.session_date, s.start_time, dur, now)) continue;
    const dateStr = formatISODateFull(s.session_date, language);
    const timeStr = formatSessionTimeRange(s.start_time, dur);
    rows.push({
      session: s,
      label: tr(language, "homeAlerts.staffWaitlistFreeSpot", { date: dateStr, time: timeStr }),
    });
  }
  /** Soonest session first within the waitlist tier (shown above late cancellations). */
  rows.sort(
    (a, b) =>
      sessionStartsAt(a.session.session_date, a.session.start_time).getTime() -
      sessionStartsAt(b.session.session_date, b.session.start_time).getTime()
  );
  return rows.map((r) => ({
    id: `wl-${r.session.id}`,
    label: r.label,
    href: staffSessionPath(variant, r.session.id),
  }));
}

/** Staff home: waitlist + free spot first; then all self-cancellations newest → oldest (cancelled_at). */
export async function mergeStaffHomeAlerts(
  variant: "coach" | "manager",
  sessions: TrainingSessionWithTrainer[],
  signupBySession: Record<string, number>,
  waitlistBySession: Record<string, number>,
  language: LanguageCode,
  now = new Date()
): Promise<HomePriorityAlertItem[]> {
  const a = buildStaffWaitlistFreeSpotItems(sessions, signupBySession, waitlistBySession, variant, language, now);
  const b = await fetchStaffLateCancellationItems(variant, language, now);
  const seen = new Set<string>();
  const out: HomePriorityAlertItem[] = [];
  for (const x of [...a, ...b]) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

export async function fetchStaffLateCancellationItems(
  variant: "coach" | "manager",
  language: LanguageCode,
  now = new Date()
): Promise<HomePriorityAlertItem[]> {
  const { data, error } = await supabase
    .from("cancellations")
    .select(
      "id, cancelled_at, charged_full_price, user_id, training_sessions!inner ( id, session_date, start_time, duration_minutes )"
    )
    .order("cancelled_at", { ascending: false })
    .limit(60);

  if (error || !data?.length) return [];

  const userIds = [...new Set(data.map((r: { user_id: string }) => r.user_id))];
  const { data: profiles } = await supabase.from("profiles").select("user_id, full_name").in("user_id", userIds);
  const nameByUser = Object.fromEntries((profiles ?? []).map((p) => [p.user_id, p.full_name?.trim() ?? ""]));

  const rows: { item: HomePriorityAlertItem; cancelMs: number }[] = [];
  for (const row of data as {
    id: string;
    cancelled_at: string;
    charged_full_price: boolean | null;
    user_id: string;
    training_sessions:
      | { id: string; session_date: string; start_time: string; duration_minutes: number | null }
      | { id: string; session_date: string; start_time: string; duration_minutes: number | null }[];
  }[]) {
    const sess = Array.isArray(row.training_sessions) ? row.training_sessions[0] : row.training_sessions;
    if (!sess?.id) continue;
    const dur = sess.duration_minutes ?? 60;
    if (!hasSessionNotEnded(sess.session_date, sess.start_time, dur, now)) continue;
    if (now.getTime() - new Date(row.cancelled_at).getTime() > MS_7D) continue;

    const name = nameByUser[row.user_id] || tr(language, "homeAlerts.athlete");
    const dayStr = formatISODateDayMonth(sess.session_date, language);
    const timeStr = formatSessionStartTime(sess.start_time);
    const cancelMs = new Date(row.cancelled_at).getTime();
    const isNew = Number.isFinite(cancelMs) && now.getTime() - cancelMs <= MS_1H && now.getTime() >= cancelMs;
    const charged = row.charged_full_price === true;
    const lead = tr(
      language,
      charged ? "homeAlerts.lateCancellationLead" : "homeAlerts.cancellationLead"
    );
    const dayTime = `${dayStr} · ${timeStr}`;
    const beforeName = " · ";
    const leadDir: "ltr" | "rtl" = language === "he" ? "rtl" : "ltr";
    const dayTimeDir: "ltr" | "rtl" = language === "he" ? "rtl" : "ltr";
    const beforeNameDir: "ltr" | "rtl" = language === "he" ? "rtl" : "ltr";
    const nameDir: "ltr" | "rtl" = isRtlScript(name) ? "rtl" : "ltr";
    const flatLabel = `${lead}${dayTime}${beforeName}${name}`;
    rows.push({
      cancelMs: Number.isFinite(cancelMs) ? cancelMs : 0,
      item: {
        id: `lc-${row.id}`,
        label: flatLabel,
        labelSegments: [
          { text: lead, dir: leadDir, role: "subject" },
          { text: dayTime, dir: dayTimeDir, role: "body" },
          { text: beforeName, dir: beforeNameDir, role: "body" },
          { text: name, dir: nameDir, role: "body" },
        ],
        href: staffSessionPath(variant, sess.id),
        isNew,
      },
    });
  }

  rows.sort((a, b) => b.cancelMs - a.cancelMs);
  return rows.map((r) => r.item);
}

export async function fetchRegistrationBannerState(): Promise<RegistrationBannerState | null> {
  const { data, error } = await supabase.rpc("get_next_weekly_registration_banner_state");
  if (error || data == null) return null;
  const o = (typeof data === "string" ? JSON.parse(data) : data) as Record<string, unknown>;
  if (o.ok !== true) return null;
  return {
    show_registration_countdown: !!o.show_registration_countdown,
    show_registration_still_pending: !!o.show_registration_still_pending,
    next_open_at_utc: String(o.next_open_at_utc ?? ""),
    eligible_next_week_count: Number(o.eligible_next_week_count ?? 0),
    current_unlock_week_start: o.current_unlock_week_start != null ? String(o.current_unlock_week_start) : undefined,
  };
}

export async function fetchAthleteHomeAlertItems(
  language: LanguageCode,
  now = new Date()
): Promise<HomePriorityAlertItem[]> {
  const [state, waitItems] = await Promise.all([
    fetchRegistrationBannerState(),
    fetchAthleteWaitlistOpenSpotItems(language, now),
  ]);
  const regItems = buildAthleteRegistrationItems(state, language);
  return [...regItems, ...waitItems];
}

function formatUtcOpeningLabel(isoZ: string, language: LanguageCode): string {
  const d = new Date(isoZ);
  if (!Number.isFinite(d.getTime())) return isoZ;
  const datePart = isoZ.slice(0, 10);
  const dateFormatted = formatISODateDayMonthWithWeekday(datePart, language);
  const timeUtc = d.toLocaleTimeString(language === "he" ? "he-IL" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${dateFormatted} · ${timeUtc}`;
}

export function buildAthleteRegistrationItems(
  state: RegistrationBannerState | null,
  language: LanguageCode
): HomePriorityAlertItem[] {
  if (!state) return [];
  const items: HomePriorityAlertItem[] = [];
  if (state.show_registration_countdown && state.eligible_next_week_count > 0 && state.next_open_at_utc) {
    const rid = `reg-cd-${state.next_open_at_utc}`;
    const detail = formatUtcOpeningLabel(state.next_open_at_utc, language);
    const lead = tr(language, "homeAlerts.registrationOpensLead");
    const leadDir: "ltr" | "rtl" = language === "he" ? "rtl" : "ltr";
    const detailDir: "ltr" | "rtl" = language === "he" ? "rtl" : "ltr";
    items.push({
      id: rid,
      label: `${lead} ${detail}`,
      labelSegments: [
        { text: lead, dir: leadDir, role: "subject" },
        { text: detail, dir: detailDir, role: "body" },
      ],
      href: "/(app)/athlete/sessions",
    });
  } else if (state.show_registration_still_pending) {
    const rid =
      state.current_unlock_week_start && state.current_unlock_week_start.length > 0
        ? `reg-pend-${state.current_unlock_week_start}`
        : "reg-pending";
    items.push({
      id: rid,
      label: tr(language, "homeAlerts.registrationStillPending"),
      href: "/(app)/athlete/sessions",
    });
  }
  return items;
}

/**
 * Waitlisted sessions with free capacity, registration open, user not actively registered; session not ended.
 */
export async function fetchAthleteWaitlistOpenSpotItems(
  language: LanguageCode,
  now = new Date()
): Promise<HomePriorityAlertItem[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: waits, error: wErr } = await supabase.from("waitlist_requests").select("session_id").eq("user_id", user.id);
  if (wErr || !waits?.length) return [];

  const sessionIds = [...new Set(waits.map((w) => w.session_id))];
  const counts = await fetchActiveSignupCountsBySession(sessionIds);
  const { data: sessions, error: sErr } = await supabase
    .from("training_sessions")
    .select("id, session_date, start_time, duration_minutes, max_participants, is_open_for_registration")
    .in("id", sessionIds);
  if (sErr || !sessions?.length) return [];

  const { data: activeRegs } = await supabase
    .from("session_registrations")
    .select("session_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .in("session_id", sessionIds);
  const activeSet = new Set((activeRegs ?? []).map((r) => r.session_id));

  const rows: { session: (typeof sessions)[0]; label: string }[] = [];
  for (const s of sessions) {
    if (activeSet.has(s.id)) continue;
    const dur = s.duration_minutes ?? 60;
    if (!hasSessionNotEnded(s.session_date, s.start_time, dur, now)) continue;
    if (!s.is_open_for_registration) continue;
    const n = counts[s.id] ?? 0;
    if (n >= s.max_participants) continue;

    const dateStr = formatISODateFull(s.session_date, language);
    rows.push({
      session: s,
      label: tr(language, "homeAlerts.athleteWaitlistSpot", { date: dateStr }),
    });
  }
  rows.sort(
    (a, b) =>
      sessionStartsAt(a.session.session_date, a.session.start_time).getTime() -
      sessionStartsAt(b.session.session_date, b.session.start_time).getTime()
  );
  return rows.map((r) => ({
    id: `aw-${r.session.id}`,
    label: r.label,
    href: `/(app)/athlete/session/${r.session.id}` as Href,
  }));
}
