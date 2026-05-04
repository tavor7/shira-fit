import type { LanguageCode } from "../i18n/translations";
import { appLocale } from "./appLocale";
import { parseISODateLocal } from "./isoDate";

export { appLocale } from "./appLocale";

function langOrEn(language: LanguageCode | undefined): LanguageCode {
  return language ?? "en";
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const lang = langOrEn(language);
  return d.toLocaleString(appLocale(lang), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
