import type { LanguageCode } from "../i18n/translations";

/** en-GB + he-IL so full dates read as day → month → year (not US month-first). */
export function appLocale(language: LanguageCode): string {
  return language === "he" ? "he-IL" : "en-GB";
}

/**
 * One convention for compact English month labels (Phase 5 / P): three letters everywhere.
 * en-GB formats September as "Sept" among "Aug"/"Oct"; Hebrew short forms are unchanged.
 */
export function normalizeShortMonth(s: string): string {
  return s.replace(/\bSept\b/g, "Sep");
}
