import type { LanguageCode } from "../i18n/translations";
import { appLocale } from "./appLocale";

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** Local calendar date → YYYY-MM-DD (no UTC shift). */
export function toISODateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
