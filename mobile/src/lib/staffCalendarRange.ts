import { addDaysToISODate } from "./sessionTime";

/**
 * Bounded staff calendar fetch (Performance Phase 2). Staff homes and the roster calendar used to load every session
 * ever created, plus three count RPCs over every id, on every visit and refresh, so each load grew with the studio's
 * history (883 sessions in production on 2026-10-31, ~35 more a week).
 *
 * They now load from one week before the earlier of the visible week and the current week, through all future sessions.
 * That covers everything the screens show: the visible week, the current week onward (priority alerts, the coach
 * overview's next 7 days) and one buffer week so a single step back is instant. Browsing further back loads that range
 * on demand; until it arrives the week shows its loading state, never an empty week.
 */

/** Sunday of the week containing `now`, local time - the same week the calendar shows at offset 0. */
export function currentWeekStartIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** First session date to load for a visible week (`""` = not reported yet, i.e. the current week). */
export function staffCalendarFromDate(visibleWeekStartIso: string, now: Date = new Date()): string {
  const current = currentWeekStartIso(now);
  const earliest = visibleWeekStartIso && visibleWeekStartIso < current ? visibleWeekStartIso : current;
  return addDaysToISODate(earliest, -7);
}

/** Whether the loaded range (`loadedFrom`, null = nothing loaded yet) contains the whole visible week. */
export function isStaffWeekLoaded(visibleWeekStartIso: string, loadedFrom: string | null): boolean {
  if (!visibleWeekStartIso) return loadedFrom != null;
  return loadedFrom != null && visibleWeekStartIso >= loadedFrom;
}

/**
 * Whether to load an earlier range now: the visible week is outside the loaded range, or it is the buffer week itself
 * (so the next step back is already loaded when the user takes it).
 */
export function needsEarlierStaffRange(visibleWeekStartIso: string, loadedFrom: string | null): boolean {
  return !!visibleWeekStartIso && loadedFrom != null && visibleWeekStartIso <= loadedFrom;
}
