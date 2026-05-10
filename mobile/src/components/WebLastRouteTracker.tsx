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

const WEB_POLL_MS = 400;

/**
 * Web only: persist last in-app URL (pathname + search) per user for resume/PWA open at `/`.
 *
 * We read `window.location` (not only `usePathname()` deps) because on web, client navigations
 * can update the address bar without firing a pathname dependency update — so list pages like
 * `/manager/sessions` would otherwise be the last saved path instead of `/manager/session/:id`.
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

  /* Fast path when expo-router pathname updates. */
  useEffect(() => {
    tryPersistFromWindow();
  }, [pathname, tryPersistFromWindow]);

  /* Reliable path: SPA pushState may not bump `usePathname` in the same way on web. */
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    tryPersistFromWindow();
    const id = setInterval(tryPersistFromWindow, WEB_POLL_MS);
    return () => clearInterval(id);
  }, [tryPersistFromWindow]);

  return null;
}
