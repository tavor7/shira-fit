export type ManagerPeriodMode = "week" | "month" | "global";

export function parseManagerPeriodMode(raw: string | undefined): ManagerPeriodMode {
  if (raw === "month") return "month";
  if (raw === "global") return "global";
  return "week";
}

export function overviewTitleKey(mode: ManagerPeriodMode): string {
  if (mode === "month") return "dashboard.monthlyOverview";
  if (mode === "global") return "dashboard.globalOverview";
  return "dashboard.weeklyOverview";
}

export function sectionEyebrowKey(mode: ManagerPeriodMode): string {
  if (mode === "month") return "dashboard.sectionThisMonth";
  if (mode === "global") return "dashboard.sectionAllTime";
  return "dashboard.sectionThisWeek";
}

export function noSessionsKey(mode: ManagerPeriodMode): string {
  if (mode === "month") return "dashboard.noSessionsThisMonth";
  if (mode === "global") return "dashboard.noSessionsAllTime";
  return "dashboard.noSessionsThisWeek";
}

export function financeNoSessionsKey(mode: ManagerPeriodMode): string {
  if (mode === "month") return "dashboard.financeNoSessionsInMonth";
  if (mode === "global") return "dashboard.financeNoSessionsAllTime";
  return "dashboard.financeNoSessionsInWeek";
}
