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
 * Studio setup destinations are NOT flat tools: they sit one level deeper, under Setup (see getManagerParentHref).
 */
export function isManagerOverviewFlatTool(pathname: string): boolean {
  return (
    pathname === "/manager/trainer-colors" ||
    pathname === "/manager/roles" ||
    pathname === "/manager/activity-log" ||
    pathname === "/manager/account-payments" ||
    pathname === "/manager/documents-invoices" ||
    pathname === "/manager/pricing" ||
    pathname === "/manager/coach-capacity-pricing"
  );
}

/** Staff list → detail under overview; pop to list when possible. */
export function isManagerOverviewStaffDrilldown(pathname: string): boolean {
  return pathname.startsWith("/staff/profile/") || pathname.startsWith("/staff/manual/");
}

/** Studio setup index (phones; wider screens show the same destinations as a tab strip on each page). */
export const MANAGER_SETUP_HREF = "/(app)/manager/setup" satisfies Href;
export const STAFF_USERS_HREF = "/(app)/staff/users" satisfies Href;

/** Pathnames of the Studio setup destinations — the same set as useStudioSetupItems (kept in sync by a unit test). */
export const STUDIO_SETUP_ITEM_PATHS = [
  "/staff/users",
  "/manager/families",
  "/manager/opening-schedule",
  "/manager/birthday-messages",
  "/manager/whatsapp-rollout",
  "/manager/legal-settings",
] as const;

export function isStudioSetupIndex(pathname: string): boolean {
  return pathname === "/manager/setup";
}

export function isStudioSetupItem(pathname: string): boolean {
  return (STUDIO_SETUP_ITEM_PATHS as readonly string[]).includes(pathname);
}

/**
 * The manager hierarchy's parent screen — the one place Back (header pill and Android hardware back) is decided for
 * manager hub screens: Overview → Setup → Setup item → staff detail, and Overview → flat tools.
 *  - Setup index → Overview.
 *  - Setup item → Setup on phones (where Setup is an index list); Overview on wider screens, where Setup has no page
 *    of its own and is the tab strip shown on every setup item.
 *  - Staff profile / manual participant detail → Users list.
 *  - Overview flat tools → Overview.
 * Returns null for screens outside this hierarchy (callers keep their existing behaviour).
 */
export function getManagerParentHref(pathname: string, opts: { setupIndexAvailable: boolean }): Href | null {
  if (isStudioSetupIndex(pathname)) return MANAGER_OVERVIEW_HREF;
  if (isStudioSetupItem(pathname)) return opts.setupIndexAvailable ? MANAGER_SETUP_HREF : MANAGER_OVERVIEW_HREF;
  if (isManagerOverviewStaffDrilldown(pathname)) return STAFF_USERS_HREF;
  if (isManagerOverviewFlatTool(pathname)) return MANAGER_OVERVIEW_HREF;
  return null;
}

/** Route name inside the (app) stack for an "/(app)/…" href, e.g. "/(app)/manager/setup" → "manager/setup". */
export function appStackRouteName(href: Href): string {
  return String(href).replace(/^\/\(app\)\//, "");
}

/**
 * Go to the parent screen without corrupting history: when the previous stack entry IS the parent (the usual
 * Overview → Setup → item drill-down) pop back to it, so browser Back/Forward stay consistent and the parent keeps its
 * state. Otherwise (deep link, refresh, arrived from elsewhere) replace the current entry with the parent.
 */
export function navigateToParent(
  parent: Href,
  navigation: { canGoBack(): boolean; goBack(): void; getState?: () => { index: number; routes: { name: string }[] } | undefined },
  replace: (href: Href) => void
): "pop" | "replace" {
  const state = navigation.getState?.();
  const prev = state && state.index > 0 ? state.routes[state.index - 1] : undefined;
  if (prev && navigation.canGoBack() && prev.name === appStackRouteName(parent)) {
    navigation.goBack();
    return "pop";
  }
  replace(parent);
  return "replace";
}

export function isPendingPathname(pathname: string): boolean {
  return pathname === "/pending" || pathname.startsWith("/pending/");
}

export function isDisabledPathname(pathname: string): boolean {
  return pathname === "/disabled" || pathname.startsWith("/disabled/");
}

export function isChangePasswordPathname(pathname: string): boolean {
  return pathname === "/change-password" || pathname.startsWith("/change-password/");
}

export function isNotificationsOnboardingPathname(pathname: string): boolean {
  return pathname === "/notifications-onboarding" || pathname.startsWith("/notifications-onboarding/");
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
