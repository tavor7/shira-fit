export function formatFinanceIls(n: number, language: string): string {
  const r = Math.round(n * 100) / 100;
  return language === "he" ? `${r.toLocaleString("he-IL")} ₪` : `${r.toLocaleString("en-US")} ₪`;
}

export function formatSessionTimeShort(isoTime: string): string {
  const s = String(isoTime ?? "").trim();
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export function formatSessionRosterLine(
  s: {
    registered_count: number;
    max_participants: number;
    arrived_count: number;
    late_cancel_charged_count: number;
  },
  t: (key: string) => string
): string {
  const reg =
    s.max_participants > 0
      ? t("dashboard.financeDailyRegisteredCap")
          .replace("{registered}", String(s.registered_count))
          .replace("{max}", String(s.max_participants))
      : t("dashboard.financeDailyRegisteredOnly").replace("{registered}", String(s.registered_count));
  const arrived = t("dashboard.financeDailyArrived").replace("{n}", String(s.arrived_count));
  if (s.late_cancel_charged_count > 0) {
    const late = t("dashboard.financeDailyLateCancel").replace("{n}", String(s.late_cancel_charged_count));
    return `${reg} · ${arrived} · ${late}`;
  }
  return `${reg} · ${arrived}`;
}
