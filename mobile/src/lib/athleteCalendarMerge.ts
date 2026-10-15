/**
 * Pure helpers for the athlete calendar (Performance Phase 1 / step 3): the calendar is now built from two fixed-size
 * requests instead of URLs carrying growing id lists.
 */

export type CalendarSessionRow = { id: string; session_date: string; start_time: string };

/** A `session_registrations → training_sessions!inner(...)` row; PostgREST returns the joined row as object or array. */
export type RegisteredSessionRow<T> = { training_sessions: T | T[] | null };

/**
 * Non-hidden sessions plus the hidden sessions the athlete is registered in, de-duplicated by id and ordered by date
 * then start time (the order the single query used to return).
 */
export function mergeAthleteCalendarSessions<T extends CalendarSessionRow>(
  visible: T[] | null | undefined,
  registeredHidden: RegisteredSessionRow<T>[] | null | undefined
): T[] {
  const byId = new Map<string, T>();
  for (const s of visible ?? []) byId.set(s.id, s);
  for (const r of registeredHidden ?? []) {
    const ts = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
    if (ts?.id) byId.set(ts.id, ts);
  }
  return [...byId.values()].sort(
    (a, b) => a.session_date.localeCompare(b.session_date) || String(a.start_time).localeCompare(String(b.start_time))
  );
}

/** The athlete's own rows (fetched by user id) that are on the calendar being shown. */
export function sessionIdsOnCalendar(
  rows: { session_id: string }[] | null | undefined,
  calendar: { id: string }[]
): string[] {
  const onCalendar = new Set(calendar.map((s) => s.id));
  return (rows ?? []).map((r) => String(r.session_id)).filter((id) => onCalendar.has(id));
}
