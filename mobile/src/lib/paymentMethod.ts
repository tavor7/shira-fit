import type { LanguageCode } from "../i18n/translations";

/** Stored payment_method values selectable in session / account payment UI. */
export const SESSION_PAYMENT_METHOD_KEYS = ["cash", "paybox", "mom", "other"] as const;
export type SessionPaymentMethodKey = (typeof SESSION_PAYMENT_METHOD_KEYS)[number];

export function isSessionPaymentMethodKey(k: string): k is SessionPaymentMethodKey {
  return (SESSION_PAYMENT_METHOD_KEYS as readonly string[]).includes(k);
}

export function coerceSessionPaymentMethodKey(
  raw: string | null | undefined,
  fallback: SessionPaymentMethodKey | "" = ""
): SessionPaymentMethodKey | "" {
  const k = normalizePaymentMethodKey(raw);
  return isSessionPaymentMethodKey(k) ? k : fallback;
}

/**
 * Stable keys for payment_method storage and reporting (matches SQL normalize_payment_method_key).
 */
export function normalizePaymentMethodKey(raw: string | null | undefined): string {
  const t = String(raw ?? "").trim();
  if (!t) return "(none)";
  const tl = t.toLowerCase();
  if (["(none)", "none", "n/a", "na", "unspecified", "unpaid", "-", "—"].includes(tl)) return "(none)";
  if (tl === "cash" || t === "מזומן" || t === "Cash" || t === "CASH") return "cash";
  if (tl === "paybox" || tl === "pay box" || tl === "pay-box" || t === "PayBox" || t === "PAYBOX" || t === "פייבוקס")
    return "paybox";
  if (tl === "mom" || tl === "mother" || t === "Mom" || t === "MOM" || t === "אמא" || t === "לאמא") return "mom";
  if (tl === "other" || t === "אחר" || t === "Other" || t === "OTHER") return "other";
  if (/^[\x00-\x7F]+$/.test(t)) return tl;
  return t;
}

/** Dashboard chip: counts rows may still use legacy strings until DB migration runs — normalize then label. */
export function paymentMethodDashboardLabel(key: string, language: LanguageCode): string {
  const k = normalizePaymentMethodKey(key);
  if (k === "(none)") return language === "he" ? "לא צוין" : "Unspecified";
  if (k === "cash") return language === "he" ? "מזומן" : "Cash";
  if (k === "paybox") return "PayBox";
  if (k === "mom") return language === "he" ? "אמא" : "Mom";
  if (k === "other") return language === "he" ? "אחר" : "Other";
  return key;
}

/** Attendance list line after "Payment:" when method is set */
export function paymentMethodAttendanceLabel(key: string | null | undefined, language: LanguageCode): string {
  const k = normalizePaymentMethodKey(key);
  if (k === "(none)") return language === "he" ? "לא שולם" : "Unpaid";
  if (k === "cash") return language === "he" ? "מזומן" : "Cash";
  if (k === "paybox") return "PayBox";
  if (k === "mom") return language === "he" ? "אמא" : "Mom";
  if (k === "other") return language === "he" ? "אחר" : "Other";
  const raw = String(key ?? "").trim();
  return raw || (language === "he" ? "אחר" : "Other");
}

/** Participant history / reports: show method in current UI language */
export function paymentMethodHistoryLabel(key: string | null | undefined, language: LanguageCode): string {
  const k = normalizePaymentMethodKey(key);
  if (k === "(none)") return language === "he" ? "—" : "—";
  return paymentMethodAttendanceLabel(key, language);
}

/** Unpaid = no stored method; Cash/PayBox = green; anything else = yellow */
export function paymentDisplayTone(payment: string | null | undefined): "unpaid" | "cash_paybox" | "other" {
  const k = normalizePaymentMethodKey(payment);
  if (k === "(none)") return "unpaid";
  if (k === "cash" || k === "paybox" || k === "mom") return "cash_paybox";
  return "other";
}

export function isSessionPaymentRecorded(paymentMethod: string | null | undefined): boolean {
  return paymentDisplayTone(paymentMethod) !== "unpaid";
}
