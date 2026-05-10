import { Platform } from "react-native";
import { router } from "expo-router";

/** Trace `/(app)/manager/sessions` redirects (console + sessionStorage). Keep false in production. */
export const DEBUG_MANAGER_SESSIONS_REDIRECT_TRACE = false;

export type ManagerSessionsRedirectSnapshot = {
  authLoading?: boolean;
  authUserId?: string | null;
  profileRole?: string | null;
  /** Training session id from URL when redirecting from session detail flows. */
  routeSessionId?: string | null;
};

export function logRedirectToManagerSessions(
  sourceFile: string,
  reason: string,
  snapshot?: ManagerSessionsRedirectSnapshot
) {
  if (!DEBUG_MANAGER_SESSIONS_REDIRECT_TRACE) return;
  const windowPathname =
    Platform.OS === "web" && typeof window !== "undefined" ? window.location.pathname : "";
  const payload = {
    t: new Date().toISOString(),
    sourceFile,
    reason,
    windowPathname,
    ...snapshot,
  };
  console.warn("[ShiraFit → /(app)/manager/sessions]", payload);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("shirafit:lastManagerSessionsRedirectDebug", JSON.stringify(payload));
    }
  } catch {
    /* ignore */
  }
}

export function replaceToManagerSessions(
  sourceFile: string,
  reason: string,
  snapshot?: ManagerSessionsRedirectSnapshot
) {
  logRedirectToManagerSessions(sourceFile, reason, snapshot);
  router.replace("/(app)/manager/sessions");
}
