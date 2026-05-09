import { Platform } from "react-native";
import type { Profile } from "../types/database";

/** Used when the browser reloads and lands on `/` — resume last in-app screen (web only). */
export const WEB_LAST_ROUTE_KEY = "shira_fit_web_last_path";

const AUTH_PATH_PREFIXES = ["/login", "/signup", "/reset-password", "/password-updated", "/signup-success"];

function webStorage(): Storage | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearWebLastRoute(): void {
  const s = webStorage();
  if (!s) return;
  try {
    s.removeItem(WEB_LAST_ROUTE_KEY);
  } catch {
    // ignore (private mode, quota)
  }
}

export function saveWebLastRoute(fullPath: string): void {
  const s = webStorage();
  if (!s) return;
  const trimmed = fullPath.trim();
  if (!trimmed || trimmed === "/") return;
  const pathOnly = trimmed.split("?")[0] ?? "";
  if (AUTH_PATH_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`))) return;
  try {
    s.setItem(WEB_LAST_ROUTE_KEY, trimmed);
  } catch {
    // ignore
  }
}

export function getWebLastRoute(): string | null {
  const s = webStorage();
  if (!s) return null;
  try {
    const v = s.getItem(WEB_LAST_ROUTE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * `usePathname()` is the public URL (e.g. `/manager/reports`). Expo `Redirect` hrefs in this app use the
 * filesystem group prefix `/(app)/...`. Without it, resume redirects may not match and users fall through to `/sessions`.
 */
export function normalizeWebResumeHref(stored: string): string {
  const qIdx = stored.indexOf("?");
  const pathOnly = qIdx >= 0 ? stored.slice(0, qIdx) : stored;
  const query = qIdx >= 0 ? stored.slice(qIdx) : "";

  if (!pathOnly || pathOnly === "/") return stored;
  if (pathOnly.startsWith("/(")) return `${pathOnly}${query}`;
  return `/(app)${pathOnly}${query}`;
}

export function isWebResumePathAllowed(
  fullPath: string,
  profile: Pick<Profile, "role" | "approval_status">,
  managerAthletePreview: boolean
): boolean {
  const pathOnly = fullPath.split("?")[0] ?? "";
  if (!pathOnly || pathOnly === "/") return false;
  if (AUTH_PATH_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`))) return false;

  const { role, approval_status } = profile;
  if (role === "athlete") {
    if (approval_status === "pending") return pathOnly.startsWith("/pending");
    return pathOnly.startsWith("/athlete") || pathOnly.startsWith("/pending");
  }
  if (role === "coach") return pathOnly.startsWith("/coach");
  if (role === "manager") {
    if (pathOnly.startsWith("/manager")) return true;
    if (pathOnly.startsWith("/athlete") && managerAthletePreview) return true;
    return false;
  }
  return false;
}
