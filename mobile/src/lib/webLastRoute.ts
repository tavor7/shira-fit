import { Platform } from "react-native";
import type { Profile } from "../types/database";

/** Used when the browser reloads and lands on `/` — resume last in-app screen (web only). */
export const WEB_LAST_ROUTE_KEY = "shira_fit_web_last_path";

const AUTH_PATH_PREFIXES = ["/login", "/signup", "/reset-password", "/password-updated", "/signup-success"];

export function clearWebLastRoute(): void {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(WEB_LAST_ROUTE_KEY);
  } catch {
    // ignore (private mode, quota)
  }
}

export function saveWebLastRoute(fullPath: string): void {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
  const trimmed = fullPath.trim();
  if (!trimmed || trimmed === "/") return;
  const pathOnly = trimmed.split("?")[0] ?? "";
  if (AUTH_PATH_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`))) return;
  try {
    sessionStorage.setItem(WEB_LAST_ROUTE_KEY, trimmed);
  } catch {
    // ignore
  }
}

export function getWebLastRoute(): string | null {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return null;
  try {
    const v = sessionStorage.getItem(WEB_LAST_ROUTE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
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
