export const DOCUMENT_SERVICE_TYPE_KEYS = [
  "kickboxing",
  "personal",
  "pair",
  "trio",
  "quartet",
  "quintet",
  "sextet",
  "group_over_6",
  "other",
] as const;

export type DocumentServiceTypeKey = (typeof DOCUMENT_SERVICE_TYPE_KEYS)[number];

/** Service types for account payments — Trainings first (default). */
export const ACCOUNT_PAYMENT_SERVICE_TYPE_KEYS: DocumentServiceTypeKey[] = [
  "other",
  ...DOCUMENT_SERVICE_TYPE_KEYS.filter((k) => k !== "other"),
];

const HEBREW_MONTH_NAMES = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
] as const;

const LABELS_HE: Record<DocumentServiceTypeKey, string> = {
  kickboxing: "אימון קיקבוקס",
  personal: "אימון אישי",
  pair: "אימון זוגי",
  trio: "אימון שלישייה",
  quartet: "אימון רביעייה",
  quintet: "אימון חמישייה",
  sextet: "אימון שישייה",
  group_over_6: "אימון קבוצה - מעל 6 משתתפים",
  other: "אימונים",
};

const LABELS_EN: Record<DocumentServiceTypeKey, string> = {
  kickboxing: "Kickboxing training",
  personal: "Personal training",
  pair: "Pair training",
  trio: "Trio training",
  quartet: "Quartet training",
  quintet: "Quintet training",
  sextet: "Sextet training",
  group_over_6: "Group training (6+)",
  other: "Trainings",
};

export function documentServiceTypeLabel(key: string, language: "he" | "en"): string {
  const k = key as DocumentServiceTypeKey;
  if (language === "he") return LABELS_HE[k] ?? key;
  return LABELS_EN[k] ?? key;
}

export function documentServiceTypePdfLabel(key: string, description?: string | null): string {
  const base = LABELS_HE[key as DocumentServiceTypeKey] ?? key;
  if (key === "other" && description?.trim()) return `אימונים — ${description.trim()}`;
  return base;
}

/** Default receipt line for account Trainings: "אימונים שוטף {month}". */
export function defaultTrainingsServiceDescription(ref: Date | string = new Date()): string {
  let d: Date;
  if (typeof ref === "string") {
    const parts = ref.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (parts) {
      d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    } else {
      d = new Date();
    }
  } else {
    d = ref;
  }
  const month = HEBREW_MONTH_NAMES[d.getMonth()] ?? "";
  return month ? `אימונים שוטף ${month}` : "אימונים שוטף";
}

/** Map session capacity + kickbox flag to document service type. */
export function serviceTypeFromSession(maxParticipants: number, isKickbox: boolean): DocumentServiceTypeKey {
  if (isKickbox) return "kickboxing";
  switch (maxParticipants) {
    case 1:
      return "personal";
    case 2:
      return "pair";
    case 3:
      return "trio";
    case 4:
      return "quartet";
    case 5:
      return "quintet";
    case 6:
      return "sextet";
    default:
      return "group_over_6";
  }
}
