export const DOCUMENT_PAYMENT_METHOD_KEYS = [
  "cash",
  "paybox",
  "mom",
  "bit",
  "bank_transfer",
  "credit_card",
  "check",
  "other",
] as const;

export type DocumentPaymentMethodKey = (typeof DOCUMENT_PAYMENT_METHOD_KEYS)[number];

const LABELS_HE: Record<DocumentPaymentMethodKey, string> = {
  cash: "מזומן",
  paybox: "PayBox",
  mom: "אמא",
  bit: "ביט",
  bank_transfer: "העברה בנקאית",
  credit_card: "כרטיס אשראי",
  check: "צ'ק",
  other: "אחר",
};

const LABELS_EN: Record<DocumentPaymentMethodKey, string> = {
  cash: "Cash",
  paybox: "PayBox",
  mom: "Mom",
  bit: "Bit",
  bank_transfer: "Bank transfer",
  credit_card: "Credit card",
  check: "Check",
  other: "Other",
};

export function documentPaymentMethodLabel(key: string | null | undefined, language: "he" | "en"): string {
  if (!key) return language === "he" ? "—" : "—";
  const k = key as DocumentPaymentMethodKey;
  return language === "he" ? (LABELS_HE[k] ?? key) : (LABELS_EN[k] ?? key);
}

export function documentPaymentMethodPdfLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return LABELS_HE[key as DocumentPaymentMethodKey] ?? key;
}

import { normalizePaymentMethodKey } from "./paymentMethod";

/** Map recorded session/account payment method to document method, if possible. */
export function mapRecordedPaymentToDocumentMethod(
  raw: string | null | undefined
): DocumentPaymentMethodKey | null {
  const k = normalizePaymentMethodKey(raw);
  if (k === "cash") return "cash";
  if (k === "paybox") return "paybox";
  if (k === "mom") return "mom";
  if (k === "other") return "other";
  return null;
}
