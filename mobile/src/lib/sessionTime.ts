/** Parse Postgres time string "HH:MM" or "HH:MM:SS" to minutes from midnight. */
export function parseTimeToMinutes(t: string): number {
  const part = t.trim().slice(0, 8);
  const [h, m] = part.split(":");
  const hh = parseInt(h ?? "0", 10);
  const mm = parseInt(m ?? "0", 10);
  return hh * 60 + mm;
}

function minutesToHHMM(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** e.g. 18:00–19:00, or start + "(90 min)" if end crosses midnight. */
export function formatSessionTimeRange(startTime: string, durationMinutes: number): string {
  const startM = parseTimeToMinutes(startTime);
  const endM = startM + durationMinutes;
  if (endM <= 24 * 60) {
    return `${minutesToHHMM(startM)}–${minutesToHHMM(endM)}`;
  }
  return `${minutesToHHMM(startM)} (${durationMinutes} min)`;
}

/** Local start instant for a session row (date + time, no timezone). */
export function sessionStartsAt(sessionDate: string, startTime: string): Date {
  const [y, mo, d] = sessionDate.split("-").map((x) => parseInt(x, 10));
  const part = startTime.trim().slice(0, 8);
  const [hh = "0", mm = "0", ss = "0"] = part.split(":");
  return new Date(y, mo - 1, d, parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10) || 0);
}

export function sessionEndsAt(sessionDate: string, startTime: string, durationMinutes: number): Date {
  return new Date(sessionStartsAt(sessionDate, startTime).getTime() + durationMinutes * 60 * 1000);
}

/**
 * True if the athlete cancelled at or within `hours` before session start (local calendar),
 * and cancellation was not after session start.
 */
export function isCancellationWithinHoursBeforeSession(
  sessionDate: string,
  startTime: string,
  cancelledAtIso: string,
  hours: number
): boolean {
  const startMs = sessionStartsAt(sessionDate, startTime).getTime();
  const cancelledMs = new Date(cancelledAtIso).getTime();
  if (!Number.isFinite(cancelledMs) || cancelledMs > startMs) return false;
  return startMs - cancelledMs <= hours * 60 * 60 * 1000;
}

export function hasSessionNotEnded(
  sessionDate: string,
  startTime: string,
  durationMinutes: number,
  now = new Date()
): boolean {
  return now.getTime() < sessionEndsAt(sessionDate, startTime, durationMinutes).getTime();
}

export function isSessionInProgress(
  sessionDate: string,
  startTime: string,
  durationMinutes: number,
  now = new Date()
): boolean {
  const start = sessionStartsAt(sessionDate, startTime).getTime();
  const end = sessionEndsAt(sessionDate, startTime, durationMinutes).getTime();
  const t = now.getTime();
  return t >= start && t < end;
}

/** For week grid / agenda: before start, during, or after the session has ended. */
export type SessionTemporalPhase = "past" | "live" | "upcoming";

export function getSessionTemporalPhase(
  sessionDate: string,
  startTime: string,
  durationMinutes: number,
  now: Date = new Date()
): SessionTemporalPhase {
  const dur = durationMinutes > 0 ? durationMinutes : 60;
  const startT = sessionStartsAt(sessionDate, startTime).getTime();
  const endT = sessionEndsAt(sessionDate, startTime, dur).getTime();
  const t = now.getTime();
  if (t < startT) return "upcoming";
  if (t < endT) return "live";
  return "past";
}

/** Add calendar days to YYYY-MM-DD without UTC shift. */
export function addDaysToISODate(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, mo - 1, d + days);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
