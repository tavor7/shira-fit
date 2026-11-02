import type { LanguageCode } from "../i18n/translations";
import { appLocale, normalizeShortMonth } from "./appLocale";
import { parseISODateLocal } from "./isoDate";

export { appLocale } from "./appLocale";

/**
 * Performance Phase 5: `date.toLocaleDateString(locale, options)` builds a new Intl.DateTimeFormat on every call, which
 * dominated the Overview's render time (Global mode formats two dates per coach session line). Every call below passes
 * explicit date / time fields, so `new Intl.DateTimeFormat(locale, options).format(date)` returns exactly the same
 * string (ECMA-402: no defaults are added when such fields are present); one formatter is kept per locale + options.
 */
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
function fmtDate(d: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = dateTimeFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, f);
  }
  return f.format(d);
}

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
  return fmtDate(d, appLocale(lang), {
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
  return fmtDate(d, appLocale(lang), { month: "long", year: "numeric" });
}

/** YYYY-MM-DD → "4 May" / Hebrew equivalent — no weekday, no year (compact alerts). */
export function formatISODateDayMonth(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return fmtDate(d, appLocale(lang), {
    day: "numeric",
    month: "long",
  });
}

/** YYYY-MM-DD → "Wed, 17 Jun" / Hebrew — short weekday + day + month, no year. */
export function formatISODateWeekdayDayMonth(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const weekday = fmtDate(d, appLocale(lang), { weekday: "short" });
  const dayMonth = normalizeShortMonth(fmtDate(d, appLocale(lang), { day: "numeric", month: "short" }));
  return `${weekday}, ${dayMonth}`;
}

/** YYYY-MM-DD → "4 May · Monday" / Hebrew — day + month + weekday, no year (registration banner, etc.). */
export function formatISODateDayMonthWithWeekday(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const dm = fmtDate(d, appLocale(lang), { day: "numeric", month: "long" });
  const weekday = fmtDate(d, appLocale(lang), { weekday: "long" });
  return `${dm} · ${weekday}`;
}

/** YYYY-MM-DD → "15 March 2026 · Friday" / Hebrew equivalent */
export function formatISODateFullWithWeekdayAfter(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const date = formatISODateFull(iso, lang);
  const weekday = fmtDate(d, appLocale(lang), { weekday: "long" });
  return `${date} · ${weekday}`;
}

/**
 * YYYY-MM-DD → "Wed, 16 Sep 2026" / Hebrew equivalent — short weekday + day + short month
 * + year, all on one line. The full-word version ("16 September 2026 · Wednesday") kept
 * wrapping to two lines in every narrow card-header it was used in (every call site had
 * numberOfLines={2} to tolerate it) — this is the fix, matching the same "don't repeat
 * more than needed" approach as formatISODateRangeCompact.
 */
export function formatISODateWeekdayDayMonthYear(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  const locale = appLocale(lang);
  const weekday = fmtDate(d, locale, { weekday: "short" });
  const dayMonthYear = normalizeShortMonth(fmtDate(d, locale, { day: "numeric", month: "short", year: "numeric" }));
  return `${weekday}, ${dayMonthYear}`;
}

/** Sheet title: weekday + full date (day, month, year). */
export function formatISODateLong(iso: string, language?: LanguageCode): string {
  const d = parseISODateLocal(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return fmtDate(d, appLocale(lang), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * YYYY-MM-DD, YYYY-MM-DD → a compact one-line range, e.g. "13–19 September 2026" (same
 * month), "28 August – 3 September 2026" (same year, different month), or
 * "29 December 2026 – 4 January 2027" (different years) — never repeats the month/year
 * needlessly, so it stays short enough to fit on one line where formatISODateFull(start)
 * + " — " + formatISODateFull(end) would wrap.
 */
export function formatISODateRangeCompact(startIso: string, endIso: string, language?: LanguageCode): string {
  const start = parseISODateLocal(startIso);
  const end = parseISODateLocal(endIso);
  if (!start || !end) return `${startIso} – ${endIso}`;
  const lang = langOrEn(language);
  const locale = appLocale(lang);
  const dash = lang === "he" ? "–" : "–";

  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();

  if (sameMonth) {
    const startDay = fmtDate(start, locale, { day: "numeric" });
    const endFull = fmtDate(end, locale, { day: "numeric", month: "long", year: "numeric" });
    return `${startDay}${dash}${endFull}`;
  }

  if (sameYear) {
    const startPart = fmtDate(start, locale, { day: "numeric", month: "long" });
    const endFull = fmtDate(end, locale, { day: "numeric", month: "long", year: "numeric" });
    return `${startPart} ${dash} ${endFull}`;
  }

  const startFull = fmtDate(start, locale, { day: "numeric", month: "long", year: "numeric" });
  const endFull = fmtDate(end, locale, { day: "numeric", month: "long", year: "numeric" });
  return `${startFull} ${dash} ${endFull}`;
}

/** ISO datetime from server → local "day month year, time" */
export function formatDateTimeForDisplay(iso: string, language?: LanguageCode): string {
  const d = parseInstantIso(iso);
  if (!d) return iso;
  const lang = langOrEn(language);
  return fmtDate(d, appLocale(lang), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
