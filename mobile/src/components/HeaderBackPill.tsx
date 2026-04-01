import { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { router, usePathname, type Href } from "expo-router";
import { useI18n } from "../context/I18nContext";
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
import { theme } from "../theme";

/**
 * No control on the sessions calendar. Session detail/manage: pop stack.
 * Manager overview: tool screens → overview hub → sessions calendar.
 * Otherwise: replace to the role’s sessions calendar.
 */
export function HeaderBackPill() {
  const navigation = useNavigation();
  const pathname = usePathname() ?? "";
  const { profile } = useAuth();
  const { enabled: athletePreview } = useManagerAthletePreview();
  const { isRTL, t } = useI18n();
  const isManager = profile?.role === "manager";

  const sessionsHomeHref = useMemo((): Href | null => {
    return getSessionsHomeHref(profile?.role, athletePreview);
  }, [profile?.role, athletePreview]);

  const onPendingGate = isPendingPathname(pathname);

  const canPop = navigation.canGoBack();
  const atSessionsHome = isSessionsCalendarHome(pathname);
  const inSessionDrilldown = isSessionFlowDrilldown(pathname);

  const visible = useMemo(() => {
    if (atSessionsHome) return false;
    if (onPendingGate) return canPop;
    return !!sessionsHomeHref;
  }, [atSessionsHome, onPendingGate, canPop, sessionsHomeHref]);

  if (!visible) return null;

  const a11yBack = t("a11y.headerBack");
  const a11yToOverview = t("a11y.headerBackToOverview");
  const a11yToSessions = t("a11y.headerBackToSessions");

  const a11yLabel = useMemo(() => {
    if ((onPendingGate && canPop) || (inSessionDrilldown && canPop)) return a11yBack;
    if (isManager && isManagerOverviewStaffDrilldown(pathname) && canPop) return a11yBack;
    if (isManager && isManagerOverviewFlatTool(pathname)) return a11yToOverview;
    if (isManager && isManagerOverviewHub(pathname)) return a11yToSessions;
    return a11yToSessions;
  }, [
    onPendingGate,
    canPop,
    inSessionDrilldown,
    isManager,
    pathname,
    a11yBack,
    a11yToOverview,
    a11yToSessions,
  ]);

  function onPress() {
    if (onPendingGate && navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (inSessionDrilldown && navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (isManager && isManagerOverviewFlatTool(pathname)) {
      router.replace(MANAGER_OVERVIEW_HREF);
      return;
    }
    if (isManager && isManagerOverviewStaffDrilldown(pathname)) {
      if (navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      router.replace(MANAGER_OVERVIEW_HREF);
      return;
    }
    if (isManager && isManagerOverviewHub(pathname)) {
      if (sessionsHomeHref) router.replace(sessionsHomeHref);
      return;
    }
    if (!onPendingGate && sessionsHomeHref) {
      router.replace(sessionsHomeHref);
    }
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
    >
      <Text style={styles.arrow} importantForAccessibility="no">
        {isRTL ? "→" : "←"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    width: 38,
    height: 38,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  pillPressed: { opacity: 0.88, backgroundColor: theme.colors.surface },
  arrow: {
    color: theme.colors.cta,
    fontSize: 20,
    fontWeight: "900",
    marginTop: -1,
  },
});
