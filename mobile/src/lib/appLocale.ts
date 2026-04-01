import type { LanguageCode } from "../i18n/translations";

/** en-GB + he-IL so full dates read as day → month → year (not US month-first). */
export function appLocale(language: LanguageCode): string {
  return language === "he" ? "he-IL" : "en-GB";
}
