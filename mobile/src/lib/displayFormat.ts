/**
 * Display-only formatting for mixed Hebrew / English / numeric UI text (Phase 4A).
 *
 * Paragraph direction follows the UI language, so values whose internal order must not mirror
 * (time and day ranges, amounts, phone numbers, codes) are wrapped in Unicode directional isolates
 * (UAX #9), and user-entered text (names, notes) is isolated so it cannot reorder the surrounding
 * sentence.
 *
 * The isolate characters are invisible but they are real characters: use these helpers ONLY for text
 * that is rendered. Never persist, send, compare, search, export or log their output — use the raw
 * formatters (e.g. `formatSessionTimeRange`) and raw values for that.
 */
import type { LanguageCode } from "../i18n/translations";
import { formatISODateRangeCompact } from "./dateFormat";
import { formatSessionTimeRange } from "./sessionTime";

const LRI = "\u2066";
const FSI = "\u2068";
const PDI = "\u2069";
const ISOLATES = /[\u2066\u2067\u2068\u2069]/g;

/** Left-to-right isolate: content keeps its internal LTR order inside RTL or LTR text. */
export function displayLtr(value: string): string {
  return value ? `${LRI}${value}${PDI}` : value;
}

/** First-strong isolate for user content (names, notes): direction from its own first strong letter, no effect on neighbours. */
export function displayUserText(value: string | null | undefined): string {
  const v = String(value ?? "");
  return v ? `${FSI}${v}${PDI}` : v;
}

/** Session time range for display, e.g. "18:00–19:00", always drawn start-before-end. */
export function displayTimeRange(startTime: string, durationMinutes: number): string {
  return displayLtr(formatSessionTimeRange(startTime, durationMinutes));
}

/**
 * Shekel amount for display: "₪480", "₪480.50", "₪1,250.50", "-₪50".
 * Whole amounts drop ".00"; fractional amounts show two decimals. Display only — never feed the
 * result back into calculations, comparisons, exports or storage.
 */
export function displayMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = cents % 100 === 0;
  const body = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return displayLtr(`${amount < 0 && cents !== 0 ? "-" : ""}₪${body}`);
}

/** Removes isolates (for tests / defensive use at a data boundary). */
export function stripDisplayIsolates(value: string): string {
  return value.replace(ISOLATES, "");
}

/**
 * Isolates numeric ranges ("4–10", "18:00–19:00") inside a display string so they read
 * start-to-end in Hebrew too (the en dash is direction-neutral). Display only.
 */
export function isolateNumericRanges(text: string): string {
  return text.replace(/\d[\d:.]*\s?[–-]\s?\d[\d:.]*/g, (m) => displayLtr(m));
}

/** `formatISODateRangeCompact` for display, e.g. "4–10 October 2026" with the day span isolated. */
export function displayDateRange(startIso: string, endIso: string, language?: LanguageCode): string {
  return isolateNumericRanges(formatISODateRangeCompact(startIso, endIso, language));
}
