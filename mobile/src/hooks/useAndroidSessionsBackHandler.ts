import { useEffect } from "react";
import { BackHandler, Platform } from "react-native";
import { router, usePathname } from "expo-router";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import {
  getSessionsHomeHref,
  isPendingPathname,
  isManagerOverviewFlatTool,
  isManagerOverviewHub,
  isManagerOverviewStaffDrilldown,
  isSessionFlowDrilldown,
  isSessionsCalendarHome,
  MANAGER_OVERVIEW_HREF,
} from "../lib/sessionsHomeNavigation";
import { logRedirectToManagerSessions } from "../lib/managerSessionsRedirectLog";

/** Android hardware back: same rules as the header back pill (overview hub, manager tools, session drill-down). */
export function useAndroidSessionsBackHandler(active: boolean) {
  const pathname = usePathname() ?? "";
  const navigation = useNavigation();
  const { profile, loading: authLoading, user } = useAuth();
  const { enabled: athletePreview } = useManagerAthletePreview();

  useEffect(() => {
    if (!active || Platform.OS !== "android") return;

    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isSessionsCalendarHome(pathname)) {
        return false;
      }
      if (isPendingPathname(pathname)) {
        if (navigation.canGoBack()) {
          navigation.goBack();
          return true;
        }
        return false;
      }

      const href = getSessionsHomeHref(profile?.role, athletePreview);
      const isManager = profile?.role === "manager";

      if (isSessionFlowDrilldown(pathname) && navigation.canGoBack()) {
        navigation.goBack();
        return true;
      }
      if (isManager && isManagerOverviewFlatTool(pathname)) {
        router.replace(MANAGER_OVERVIEW_HREF);
        return true;
      }
      if (isManager && isManagerOverviewStaffDrilldown(pathname)) {
        if (navigation.canGoBack()) {
          navigation.goBack();
          return true;
        }
        router.replace(MANAGER_OVERVIEW_HREF);
        return true;
      }
      if (isManager && isManagerOverviewHub(pathname)) {
        if (href) {
          if (href === "/(app)/manager/sessions") {
            logRedirectToManagerSessions("src/hooks/useAndroidSessionsBackHandler.ts", "android_back_overview_to_sessions", {
              authLoading,
              authUserId: user?.id ?? null,
              profileRole: profile?.role ?? null,
            });
          }
          router.replace(href);
          return true;
        }
        if (navigation.canGoBack()) {
          navigation.goBack();
          return true;
        }
        return false;
      }
      if (href) {
        if (href === "/(app)/manager/sessions") {
          logRedirectToManagerSessions("src/hooks/useAndroidSessionsBackHandler.ts", "android_back_fallback_sessions_home", {
            authLoading,
            authUserId: user?.id ?? null,
            profileRole: profile?.role ?? null,
          });
        }
        router.replace(href);
        return true;
      }
      if (navigation.canGoBack()) {
        navigation.goBack();
        return true;
      }
      return false;
    });

    return () => sub.remove();
  }, [active, pathname, navigation, profile?.role, athletePreview, authLoading, user?.id]);
}
