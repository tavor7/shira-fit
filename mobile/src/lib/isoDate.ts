import type { LanguageCode } from "../i18n/translations";
import { appLocale } from "./appLocale";

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** Local calendar date → YYYY-MM-DD (no UTC shift). */
export function toISODateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** First day of the month containing `ref` (default: today), local calendar. */
export function firstDayOfMonthISOLocal(ref: Date = new Date()): string {
  return toISODateLocal(new Date(ref.getFullYear(), ref.getMonth(), 1));
}

/** Move to the first day of the month offset by `deltaMonths` from the month containing `iso` (YYYY-MM-DD). */
export function shiftMonthAnchorISOLocal(iso: string, deltaMonths: number): string {
  const d = parseISODateLocal(iso);
  const ref = d ?? new Date();
  const nd = new Date(ref.getFullYear(), ref.getMonth() + deltaMonths, 1);
  return toISODateLocal(nd);
}

/** Last day of the month containing `ref` (Date or YYYY-MM-DD). */
export function lastDayOfMonthISOLocal(ref: Date | string = new Date()): string {
  const d = typeof ref === "string" ? parseISODateLocal(ref) : ref;
  const base = d ?? new Date();
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return toISODateLocal(last);
}

/** Inclusive range ending today: last N calendar days. */
export function lastNDaysRangeISO(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  start.setDate(start.getDate() - (days - 1));
  return { start: toISODateLocal(start), end: toISODateLocal(end) };
}

/** Full calendar month containing `anchor` (YYYY-MM-DD). */
export function monthRangeISO(anchor: string): { start: string; end: string } | null {
  const d = parseISODateLocal(anchor);
  if (!d) return null;
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: toISODateLocal(start), end: toISODateLocal(end) };
}

/** True when [start, end] is exactly one full calendar month (local calendar). */
export function isFullCalendarMonthRangeISO(start: string, end: string): boolean {
  const s = parseISODateLocal(start);
  if (!s) return false;
  const range = monthRangeISO(toISODateLocal(s));
  return !!range && range.start === start && range.end === end;
}

export function parseISODateLocal(s: string): Date | null {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const [y, m, d] = t.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function isValidISODateString(s: string): boolean {
  return parseISODateLocal(s) !== null;
}

/** Compact display without weekday — used in pricing lists. */
export function formatISODatePricing(iso: string, language: LanguageCode = "en"): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  return d.toLocaleDateString(appLocale(language), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Picker / compact display: weekday + day, month, year (en-GB / he-IL order). */
export function formatISODateShortDisplay(iso: string, language: LanguageCode = "en"): string {
  const d = parseISODateLocal(iso);
  if (!d) return language === "he" ? "בחרו תאריך" : "Choose date";
  return d.toLocaleDateString(appLocale(language), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
