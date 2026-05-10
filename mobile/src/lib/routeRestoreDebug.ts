import { Platform } from "react-native";
import type { Profile } from "../types/database";
import { canRoleAccessWebPath, readWebLastRoute } from "./webLastRoute";

/** Temporary: route-restore diagnostics overlay on web. Set false to hide. */
export const ROUTE_RESTORE_DEBUG_PANEL = true;

export const ROUTE_RESTORE_DEBUG_KEY_INDEX = "shirafit:routeRestoreDebug:index";
export const ROUTE_RESTORE_DEBUG_KEY_TRACKER = "shirafit:routeRestoreDebug:tracker";

export function recordRouteRestoreTrackerDebug(savedPath: string) {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      ROUTE_RESTORE_DEBUG_KEY_TRACKER,
      JSON.stringify({ t: new Date().toISOString(), savedPath })
    );
  } catch {
    /* ignore */
  }
}

export function recordIndexRouteRestoreDebug(args: {
  loading: boolean;
  authUnavailable: boolean;
  sessionUserId: string | undefined;
  profile: Profile | null;
  athletePreviewStorageReady: boolean;
  managerAthletePreview: boolean;
  profileRetrying: boolean;
}) {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const base = { t: new Date().toISOString(), indexLocationPathname: pathname };

  const {
    loading,
    authUnavailable,
    sessionUserId,
    profile,
    athletePreviewStorageReady,
    managerAthletePreview,
    profileRetrying,
  } = args;

  try {
    if (loading) {
      sessionStorage.setItem(ROUTE_RESTORE_DEBUG_KEY_INDEX, JSON.stringify({ ...base, decision: "waiting_auth_loading" }));
      return;
    }
    if (authUnavailable) {
      sessionStorage.setItem(ROUTE_RESTORE_DEBUG_KEY_INDEX, JSON.stringify({ ...base, decision: "auth_unavailable" }));
      return;
    }
    if (!sessionUserId) {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({ ...base, decision: "index_redirect_login_no_session" })
      );
      return;
    }
    if (!profile) {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({ ...base, decision: "waiting_profile", profileRetrying })
      );
      return;
    }
    if (profile.role === "manager" && !athletePreviewStorageReady) {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({ ...base, decision: "waiting_manager_athlete_preview_storage" })
      );
      return;
    }
    if (profile.role === "athlete" && profile.approval_status === "pending") {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({ ...base, decision: "index_redirect_pending_athlete" })
      );
      return;
    }
    const saved = readWebLastRoute(sessionUserId);
    const can = !!(saved && canRoleAccessWebPath(profile.role, saved, { managerAthletePreview }));
    if (saved && can) {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({
          ...base,
          decision: "index_chose_saved_route",
          saved,
          canRoleAccessWebPath: true,
        })
      );
    } else {
      sessionStorage.setItem(
        ROUTE_RESTORE_DEBUG_KEY_INDEX,
        JSON.stringify({
          ...base,
          decision: "index_chose_role_default",
          saved: saved ?? null,
          canRoleAccessWebPath: can,
          reason: !saved ? "no_saved_or_empty" : "role_check_failed",
        })
      );
    }
  } catch {
    /* ignore */
  }
}
