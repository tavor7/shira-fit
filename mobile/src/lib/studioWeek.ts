import { toISODateLocal } from "./isoDate";

const STUDIO_TZ = "Asia/Jerusalem";

/** Today’s calendar date in the studio timezone (YYYY-MM-DD). */
export function studioTodayIso(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: STUDIO_TZ });
}

function addDaysIso(iso: string, days: number): string {
  const [y, mo, d] = iso.split("-").map((x) => parseInt(x, 10));
  const cal = new Date(y, mo - 1, d, 12, 0, 0, 0);
  cal.setDate(cal.getDate() + days);
  return toISODateLocal(cal);
}

/** Sunday-start week bounds (matches `public._week_start_sunday`). */
export function weekBoundsSunday(anchorDate: string): { start: string; end: string } {
  const [y, mo, d] = anchorDate.split("-").map((x) => parseInt(x, 10));
  const cal = new Date(y, mo - 1, d, 12, 0, 0, 0);
  cal.setDate(cal.getDate() - cal.getDay());
  const start = toISODateLocal(cal);
  const endCal = new Date(cal);
  endCal.setDate(endCal.getDate() + 6);
  return { start, end: toISODateLocal(endCal) };
}

/**
 * Last day (Sat) of next studio week — upper bound for athlete browse (matches Postgres).
 * There is no lower bound; athletes may scroll to any previous week.
 */
export function athleteBrowseWeekEnd(now = new Date()): string {
  const thisWeekStart = weekBoundsSunday(studioTodayIso(now)).start;
  return addDaysIso(thisWeekStart, 13);
}

/** @deprecated Use athleteBrowseWeekEnd(); browse has no start cap. */
export function athleteBrowseWeekBounds(now = new Date()): { start: string; end: string } {
  const { start, end } = weekBoundsSunday(studioTodayIso(now));
  return { start, end: athleteBrowseWeekEnd(now) };
}

/** Calendar week offset cap: 0 = this week, 1 = next week; no cap going backward. */
export const ATHLETE_BROWSE_MAX_WEEK_OFFSET = 1;
