import type { LanguageCode } from "../i18n/translations";
import { formatISODateDayMonthWithWeekday, parseInstantIso } from "./dateFormat";
import { appLocale } from "./appLocale";
import { supabase } from "./supabase";

const STUDIO_TZ = "Asia/Jerusalem";

export type SessionRegistrationOpenState =
  | { ok: true; status: "open" }
  | { ok: true; status: "scheduled"; scheduledOpenAt: string }
  | { ok: true; status: "pending" }
  | { ok: false; error: string };

export function formatRegistrationOpensAtLabel(isoInstant: string, language: LanguageCode): string {
  const d = parseInstantIso(isoInstant);
  if (!d) return isoInstant;
  const datePart = d.toLocaleDateString("en-CA", { timeZone: STUDIO_TZ });
  const dateFormatted = formatISODateDayMonthWithWeekday(datePart, language);
  const timeStudio = d.toLocaleTimeString(appLocale(language), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: STUDIO_TZ,
  });
  return `${dateFormatted} · ${timeStudio}`;
}

function parseRpcState(raw: unknown): SessionRegistrationOpenState | null {
  if (raw == null) return null;
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  if (o.ok !== true) {
    return { ok: false, error: String(o.error ?? "unknown") };
  }
  const status = String(o.status ?? "");
  if (status === "open") return { ok: true, status: "open" };
  if (status === "scheduled") {
    const at = String(o.scheduled_open_at ?? "");
    if (!at) return { ok: true, status: "pending" };
    return { ok: true, status: "scheduled", scheduledOpenAt: at };
  }
  if (status === "pending") return { ok: true, status: "pending" };
  return null;
}

export async function fetchSessionRegistrationOpenState(
  sessionId: string
): Promise<SessionRegistrationOpenState | null> {
  const { data, error } = await supabase.rpc("get_session_registration_open_state", {
    p_session_id: sessionId,
  });
  if (error) return null;
  return parseRpcState(data);
}

export function sessionRegistrationClosedHint(
  state: SessionRegistrationOpenState | null,
  t: (key: string) => string,
  language: LanguageCode
): string {
  if (!state?.ok) return t("athleteSession.registrationClosedHint");
  if (state.status === "scheduled") {
    const when = formatRegistrationOpensAtLabel(state.scheduledOpenAt, language);
    return t("athleteSession.registrationOpensAt").replace("{when}", when);
  }
  if (state.status === "pending") return t("athleteSession.registrationPendingManager");
  return t("athleteSession.registrationClosedHint");
}
