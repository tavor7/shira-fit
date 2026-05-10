import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import { recordRouteRestoreTrackerDebug } from "../lib/routeRestoreDebug";
import {
  canRoleAccessWebPath,
  saveWebLastRoute,
  shouldPersistWebRoute,
  isAuthOrExcludedPath,
} from "../lib/webLastRoute";

/**
 * Low-frequency safety net only. `usePathname` + `popstate` handle most updates; this catches rare
 * cases where the address bar and React disagree for a few seconds.
 */
const WEB_LOCATION_POLL_MS = 2500;

/**
 * Web only: remember the last in-app URL (per user) so opening `/` or resuming the PWA can restore
 * the correct screen (see `readWebLastRoute` in `app/index.tsx`).
 *
 * Why this component exists: on web, some client navigations update `window.location` without
 * triggering a `usePathname` dependency update, so the saved route could stay stuck on a list page
 * instead of `/manager/session/:id`. We therefore read `window.location` and use `popstate` plus a
 * slow poll while the tab is visible. Native builds do not mount this behavior (`Platform.OS === "web"` guards).
 */
export function WebLastRouteTracker() {
  const pathname = usePathname() ?? "";
  const { session, profile, loading } = useAuth();
  const { enabled: managerAthletePreview } = useManagerAthletePreview();
  const lastPersistedRef = useRef<{ uid: string; full: string } | null>(null);

  const tryPersistFromWindow = useCallback(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    if (loading) return;
    const uid = session?.user?.id;
    if (!uid || !profile?.role) return;

    const path = window.location.pathname;
    const search = window.location.search || "";
    if (isAuthOrExcludedPath(path)) return;
    if (!shouldPersistWebRoute(path)) return;
    const full = path + search;
    if (!canRoleAccessWebPath(profile.role, full, { managerAthletePreview })) return;
    const prev = lastPersistedRef.current;
    if (prev?.uid === uid && prev?.full === full) return;
    lastPersistedRef.current = { uid, full };
    saveWebLastRoute(uid, path, search);
    recordRouteRestoreTrackerDebug(full);
  }, [session?.user?.id, profile?.role, loading, managerAthletePreview]);

  /* When expo-router pathname updates, persist immediately (no wait for poll). */
  useEffect(() => {
    tryPersistFromWindow();
  }, [pathname, tryPersistFromWindow]);

  /* History back/forward + visible-tab poll (paused while hidden to avoid background timers). */
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    tryPersistFromWindow();

    const onPopState = () => {
      tryPersistFromWindow();
    };
    window.addEventListener("popstate", onPopState);

    let pollId: ReturnType<typeof setInterval> | null = null;
    const clearPoll = () => {
      if (pollId != null) {
        clearInterval(pollId);
        pollId = null;
      }
    };

    const startPollIfVisible = () => {
      clearPoll();
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      pollId = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        tryPersistFromWindow();
      }, WEB_LOCATION_POLL_MS);
    };

    const onVisibilityChange = () => {
      tryPersistFromWindow();
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        clearPoll();
      } else {
        startPollIfVisible();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    startPollIfVisible();

    return () => {
      window.removeEventListener("popstate", onPopState);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      clearPoll();
    };
  }, [tryPersistFromWindow]);

  return null;
}
