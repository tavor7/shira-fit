import type { Href } from "expo-router";
import type { UserRole } from "../types/database";

/** Manager overview hub (weekly stats + tool cards). */
export const MANAGER_OVERVIEW_HREF = "/(app)/manager/dashboard" satisfies Href;

export function isSessionsCalendarHome(pathname: string): boolean {
  return (
    pathname === "/manager/sessions" ||
    pathname === "/coach/sessions" ||
    pathname === "/athlete/sessions"
  );
}

/**
 * Stack nested under the calendar (session detail / manage). Back should pop within this subtree,
 * not replace to the calendar root (same as “subtab” / in-flow drill-down).
 */
export function isSessionFlowDrilldown(pathname: string): boolean {
  return (
    pathname.startsWith("/athlete/session/") ||
    pathname.startsWith("/coach/session/") ||
    pathname.startsWith("/manager/session/")
  );
}

export function isManagerOverviewHub(pathname: string): boolean {
  return pathname === "/manager/dashboard";
}

/**
 * Screens opened from the overview tool row — back should land on the overview hub, not skip it to sessions.
 */
export function isManagerOverviewFlatTool(pathname: string): boolean {
  return (
    pathname === "/manager/trainer-colors" ||
    pathname === "/manager/roles" ||
    pathname === "/manager/opening-schedule" ||
    pathname === "/staff/users"
  );
}

/** Staff list → detail under overview; pop to list when possible. */
export function isManagerOverviewStaffDrilldown(pathname: string): boolean {
  return pathname.startsWith("/staff/profile/") || pathname.startsWith("/staff/manual/");
}

export function isPendingPathname(pathname: string): boolean {
  return pathname === "/pending" || pathname.startsWith("/pending/");
}

/** Role-based sessions calendar — app “home” for back / Android hardware back. */
export function getSessionsHomeHref(
  role: UserRole | undefined | null,
  managerAthletePreview: boolean
): Href | null {
  if (!role) return null;
  if (role === "athlete") return "/(app)/athlete/sessions";
  if (role === "coach") return "/(app)/coach/sessions";
  if (role === "manager") {
    return managerAthletePreview ? "/(app)/athlete/sessions" : "/(app)/manager/sessions";
  }
  return null;
}
