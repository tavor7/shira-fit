import { toISODateLocal } from "./isoDate";

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
