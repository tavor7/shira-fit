import type { Href } from "expo-router";
import { Platform } from "react-native";

const STORAGE_PREFIX = "shirafit:lastWebAppRoute:";
/** Same key as ManagerAthletePreviewContext (avoid import cycle). */
const MANAGER_ATHLETE_PREVIEW_LS_KEY = "manager_athlete_preview_v1";

export function webLastRouteStorageKey(userId: string | null | undefined): string | null {
  const u = userId?.trim();
  if (!u) return null;
  return `${STORAGE_PREFIX}${u}`;
}

function readManagerAthletePreviewSyncWeb(): boolean {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(MANAGER_ATHLETE_PREVIEW_LS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Paths we never persist or follow after login. */
export function isAuthOrExcludedPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (p === "/" || p === "") return true;
  const exact = [
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/confirm-email",
    "/password-updated",
    "/forgot-sent",
    "/signup-success",
  ];
  if (exact.includes(p)) return true;
  if (p.startsWith("/(auth)")) return true;
  if (p.includes("callback")) return true;
  if (p === "/pending") return true;
  return false;
}

/**
 * In-app paths worth restoring (lists and detail screens).
 * Includes e.g. `/manager/session/:id`, `/coach/session/:id`, `/staff/profile/:id`, `/athlete/session/:id`.
 */
function isLikelyAppContentPath(pathname: string): boolean {
  return (
    pathname.startsWith("/manager/") ||
    pathname.startsWith("/coach/") ||
    pathname.startsWith("/athlete/") ||
    pathname.startsWith("/staff/") ||
    pathname.startsWith("/profile") ||
    pathname.startsWith("/settings/")
  );
}

/** Whether this browser path is worth saving as “last app screen”. */
export function shouldPersistWebRoute(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  if (isAuthOrExcludedPath(pathname)) return false;
  return isLikelyAppContentPath(pathname);
}

function splitPathAndSearch(full: string): { pathname: string; search: string } {
  const i = full.indexOf("?");
  if (i === -1) return { pathname: full, search: "" };
  return { pathname: full.slice(0, i), search: full.slice(i) };
}

/**
 * Browser/localStorage paths are `/manager/...` (no route groups). Expo Router redirects in-app
 * use the file-system group prefix `/(app)/...`; using the bare URL in `<Redirect href>` can fail
 * and fall through to role defaults after PWA resume.
 */
export function webPublicPathToExpoHref(pathWithSearch: string): Href {
  const { pathname, search } = splitPathAndSearch(pathWithSearch);
  if (pathname.startsWith("/(app)/") || pathname.startsWith("/(auth)/")) {
    return pathWithSearch as Href;
  }
  const isApp =
    pathname.startsWith("/manager/") ||
    pathname === "/manager" ||
    pathname.startsWith("/coach/") ||
    pathname === "/coach" ||
    pathname.startsWith("/athlete/") ||
    pathname === "/athlete" ||
    pathname.startsWith("/staff/") ||
    pathname === "/staff" ||
    pathname.startsWith("/settings/") ||
    pathname === "/settings" ||
    pathname === "/profile" ||
    pathname.startsWith("/profile/");
  if (isApp) {
    return (`/(app)${pathname}${search}`) as Href;
  }
  return pathWithSearch as Href;
}

/**
 * Sanitize redirect target from query param or storage.
 * Rejects absolute URLs, traversal, and auth-only paths.
 */
export function normalizeWebRedirectTarget(raw: string | null | undefined): string | null {
  if (raw == null || typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    return null;
  }
  if (/^https?:\/\//i.test(t)) return null;
  if (!t.startsWith("/")) return null;
  if (t.includes("..") || t.includes("\n") || t.includes("\r")) return null;
  const { pathname, search } = splitPathAndSearch(t);
  if (isAuthOrExcludedPath(pathname)) return null;
  if (!shouldPersistWebRoute(pathname)) return null;
  return pathname + search;
}

export function canRoleAccessWebPath(
  role: string | null | undefined,
  pathnameWithOptionalSearch: string,
  opts?: { managerAthletePreview?: boolean }
): boolean {
  if (!role) return false;
  const pathname = splitPathAndSearch(pathnameWithOptionalSearch).pathname;
  if (isAuthOrExcludedPath(pathname)) return false;
  if (!shouldPersistWebRoute(pathname)) return false;

  if (pathname.startsWith("/profile") || pathname.startsWith("/settings/")) return true;

  if (role === "athlete") {
    return pathname.startsWith("/athlete/");
  }
  if (role === "coach") {
    return pathname.startsWith("/coach/") || pathname.startsWith("/staff/");
  }
  if (role === "manager") {
    const preview = opts?.managerAthletePreview ?? readManagerAthletePreviewSyncWeb();
    if (preview && pathname.startsWith("/athlete/")) return true;
    return pathname.startsWith("/manager/") || pathname.startsWith("/staff/");
  }
  return false;
}

export function saveWebLastRoute(userId: string, pathname: string, search: string): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  const key = webLastRouteStorageKey(userId);
  if (!key) return;
  const q = search && search.startsWith("?") ? search : search ? `?${search}` : "";
  const full = pathname + q;
  if (!shouldPersistWebRoute(pathname)) return;
  if (isAuthOrExcludedPath(pathname)) return;
  try {
    localStorage.setItem(key, full);
  } catch {
    /* quota */
  }
}

export function readWebLastRoute(userId: string | null | undefined): string | null {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return null;
  const key = webLastRouteStorageKey(userId);
  if (!key) return null;
  try {
    const v = localStorage.getItem(key);
    return normalizeWebRedirectTarget(v);
  } catch {
    return null;
  }
}

/** Raw localStorage value (debug only; not normalized). */
export function peekWebLastRouteRaw(userId: string | null | undefined): string | null {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return null;
  const key = webLastRouteStorageKey(userId);
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function clearWebLastRoute(userId: string | null | undefined): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  const key = webLastRouteStorageKey(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getLoginHrefWithOptionalRedirectWeb(): Href {
  if (Platform.OS !== "web" || typeof window === "undefined") return "/(auth)/login";
  const path = window.location.pathname;
  const search = window.location.search || "";
  if (!shouldPersistWebRoute(path)) return "/(auth)/login";
  const full = path + search;
  const normalized = normalizeWebRedirectTarget(full);
  if (!normalized) return "/(auth)/login";
  return `/(auth)/login?redirect=${encodeURIComponent(normalized)}`;
}
