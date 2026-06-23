import { toISODateLocal } from "./isoDate";

export type ManagerPeriodMode = "week" | "month" | "global";

/** Global overview / reports: fixed range start (1 May 2026). End is today (server). */
export const GLOBAL_OVERVIEW_START_ISO = "2026-05-01";

/** Same all-time window as manager overview global mode. */
export function globalOverviewRangeISO(): { start: string; end: string } {
  return { start: GLOBAL_OVERVIEW_START_ISO, end: toISODateLocal(new Date()) };
}

export function isGlobalOverviewRange(start: string): boolean {
  return start.trim() === GLOBAL_OVERVIEW_START_ISO;
}

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
