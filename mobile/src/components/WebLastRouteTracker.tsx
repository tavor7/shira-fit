import { useEffect } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import {
  canRoleAccessWebPath,
  saveWebLastRoute,
  shouldPersistWebRoute,
  isAuthOrExcludedPath,
} from "../lib/webLastRoute";

/**
 * Web only: persist last in-app URL (pathname + search) per user for resume/PWA open at `/`.
 */
export function WebLastRouteTracker() {
  const pathname = usePathname() ?? "";
  const { session, profile, loading } = useAuth();
  const { enabled: managerAthletePreview } = useManagerAthletePreview();

  useEffect(() => {
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
    saveWebLastRoute(uid, path, search);
  }, [pathname, session?.user?.id, profile?.role, loading, managerAthletePreview]);

  return null;
}
