import { useEffect } from "react";
import { BackHandler, Platform, useWindowDimensions } from "react-native";
import { router, usePathname } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import {
  getManagerParentHref,
  getSessionsHomeHref,
  isPendingPathname,
  isManagerOverviewHub,
  isManagerOverviewStaffDrilldown,
  isSessionFlowDrilldown,
  isSessionsCalendarHome,
  navigateToParent,
} from "../lib/sessionsHomeNavigation";
import { STUDIO_SETUP_INDEX_MAX_WIDTH } from "../components/ManagerOverviewTabs";
import { logRedirectToManagerSessions } from "../lib/managerSessionsRedirectLog";

/** Android hardware back: same rules as the header back pill (overview hub, setup, manager tools, session drill-down). */
export function useAndroidSessionsBackHandler(active: boolean) {
  const pathname = usePathname() ?? "";
  const navigation = useNavigation();
  const { profile, loading: authLoading, user } = useAuth();
  const { enabled: athletePreview } = useManagerAthletePreview();
  const { width } = useWindowDimensions();
  const setupIndexAvailable = width < STUDIO_SETUP_INDEX_MAX_WIDTH;

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
      const managerParent = isManager ? getManagerParentHref(pathname, { setupIndexAvailable }) : null;
      if (isManager && isManagerOverviewStaffDrilldown(pathname)) {
        if (navigation.canGoBack()) {
          navigation.goBack();
          return true;
        }
        if (managerParent) router.replace(managerParent);
        return true;
      }
      if (managerParent) {
        navigateToParent(managerParent, navigation, (href) => router.replace(href));
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
  }, [active, pathname, navigation, profile?.role, athletePreview, authLoading, user?.id, setupIndexAvailable]);
}
