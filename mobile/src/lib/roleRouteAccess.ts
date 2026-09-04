import type { Href } from "expo-router";
import type { UserRole } from "../types/database";
import { getSessionsHomeHref, isChangePasswordPathname, isDisabledPathname, isPendingPathname } from "./sessionsHomeNavigation";

/** Normalize expo-router pathnames to public `/role/...` form (strip `/(app)` group). */
export function normalizeAppPathname(pathname: string): string {
  let p = (pathname ?? "").trim();
  if (!p) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/^\/\(app\)/, "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Profile, settings, and account-state screens available to every signed-in role. */
export function isSharedAppPath(pathname: string): boolean {
  const p = normalizeAppPathname(pathname);
  return (
    p === "/profile" ||
    p.startsWith("/profile/") ||
    p.startsWith("/settings/") ||
    isPendingPathname(p) ||
    isDisabledPathname(p) ||
    isChangePasswordPathname(p)
  );
}

export type RoleRouteAccessOpts = {
  /** Manager browsing athlete-style navigation may open `/athlete/*` routes. */
  managerAthletePreview?: boolean;
  /** Dedicated Super User account (profiles.is_super_user) may open `/super/*` routes. */
  isSuperUser?: boolean;
};

/**
 * Whether the signed-in role may view this in-app pathname (all platforms).
 * Blocks cross-role URLs (e.g. athlete opening `/manager/session/:id` from a shared link).
 */
export function canRoleAccessAppPath(
  role: string | null | undefined,
  pathname: string,
  opts?: RoleRouteAccessOpts
): boolean {
  if (!role) return false;
  const p = normalizeAppPathname(pathname);

  if (isSharedAppPath(p)) return true;

  if (role === "athlete") {
    return p === "/athlete" || p.startsWith("/athlete/");
  }
  if (role === "coach") {
    return p === "/coach" || p.startsWith("/coach/") || p === "/staff" || p.startsWith("/staff/");
  }
  if (role === "manager") {
    const preview = opts?.managerAthletePreview === true;
    if (preview && (p === "/athlete" || p.startsWith("/athlete/"))) return true;
    if (opts?.isSuperUser === true && (p === "/super" || p.startsWith("/super/"))) return true;
    return p === "/manager" || p.startsWith("/manager/") || p === "/staff" || p.startsWith("/staff/");
  }
  return false;
}

/** Default home when the current route is forbidden for this role. */
export function getRoleAccessDeniedRedirect(
  role: UserRole | null | undefined,
  managerAthletePreview: boolean
): Href {
  return getSessionsHomeHref(role, managerAthletePreview) ?? "/(app)/athlete/sessions";
}
