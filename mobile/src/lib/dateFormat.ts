import type { LanguageCode } from "../i18n/translations";
import { appLocale } from "./appLocale";
import { parseISODateLocal } from "./isoDate";

export { appLocale } from "./appLocale";

function langOrEn(language: LanguageCode | undefined): LanguageCode {
  return language ?? "en";
}

/** Parse RFC3339-ish instants from Postgres (`…+00`) and standard ISO strings. */
export function parseInstantIso(iso: string): Date | null {
  const raw = iso.trim();
  if (!raw) return null;
  const normalized = /[+-]\d{2}$/.test(raw) && !/[+-]\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
  const d = new Date(normalized);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** YYYY-MM-DD → "15 March 2026" / Hebrew equivalent */
export function formatISODateFull(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return d.toLocaleDateString(appLocale(lang), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** YYYY-MM-DD → "June 2026" / Hebrew equivalent */
export function formatMonthYear(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return d.toLocaleDateString(appLocale(lang), { month: "long", year: "numeric" });
}

/** YYYY-MM-DD → "4 May" / Hebrew equivalent — no weekday, no year (compact alerts). */
export function formatISODateDayMonth(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return d.toLocaleDateString(appLocale(lang), {
    day: "numeric",
    month: "long",
  });
}

/** YYYY-MM-DD → "Wed, 17 Jun" / Hebrew — short weekday + day + month, no year. */
export function formatISODateWeekdayDayMonth(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const weekday = d.toLocaleDateString(appLocale(lang), { weekday: "short" });
  const dayMonth = d.toLocaleDateString(appLocale(lang), { day: "numeric", month: "short" });
  return `${weekday}, ${dayMonth}`;
}

/** YYYY-MM-DD → "4 May · Monday" / Hebrew — day + month + weekday, no year (registration banner, etc.). */
export function formatISODateDayMonthWithWeekday(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const dm = d.toLocaleDateString(appLocale(lang), { day: "numeric", month: "long" });
  const weekday = d.toLocaleDateString(appLocale(lang), { weekday: "long" });
  return `${dm} · ${weekday}`;
}

/** YYYY-MM-DD → "15 March 2026 · Friday" / Hebrew equivalent */
export function formatISODateFullWithWeekdayAfter(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const date = formatISODateFull(iso, lang);
  const weekday = d.toLocaleDateString(appLocale(lang), { weekday: "long" });
  return `${date} · ${weekday}`;
}

/** Sheet title: weekday + full date (day, month, year). */
export function formatISODateLong(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return d.toLocaleDateString(appLocale(lang), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** ISO datetime from server → local "day month year, time" */
export function formatDateTimeForDisplay(iso: string, language?: LanguageCode): string {
  const d = parseInstantIso(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return d.toLocaleString(appLocale(lang), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
