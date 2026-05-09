import { Stack, Redirect, usePathname, useRouter, type Href } from "expo-router";
import { ActivityIndicator, Platform, View, type TextStyle, type ViewStyle } from "react-native";
import { useLayoutEffect } from "react";
import { useAuth } from "../../src/context/AuthContext";
import { AppHeaderRight } from "../../src/components/AppHeaderRight";
import { AppHeaderLeft } from "../../src/components/AppHeaderLeft";
import { useManagerAthletePreview } from "../../src/context/ManagerAthletePreviewContext";
import { isWebResumePathAllowed, normalizeWebResumeHref } from "../../src/lib/webLastRoute";
import { theme } from "../../src/theme";
import { useAndroidSessionsBackHandler } from "../../src/hooks/useAndroidSessionsBackHandler";
import { isPendingPathname } from "../../src/lib/sessionsHomeNavigation";
import { useI18n } from "../../src/context/I18nContext";

const headerStyle: ViewStyle = {
  backgroundColor: theme.colors.backgroundAlt,
  borderBottomWidth: 1,
  borderBottomColor: theme.colors.borderMuted,
};

const headerTitleStyle: TextStyle = {
  fontWeight: "600",
  fontSize: 17,
  color: theme.colors.text,
  letterSpacing: 0.2,
};

/** After a hard reload, the address bar can still show a deep link while React Navigation briefly matches "home". */
function WebAddressBarSync() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { profile } = useAuth();
  const { enabled: managerAthletePreview, storageReady } = useManagerAthletePreview();

  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    if (!profile) return;
    if (profile.role === "manager" && !storageReady) return;

    const full = window.location.pathname + (window.location.search || "");
    if (!full || full === "/") return;
    if (!isWebResumePathAllowed(full, profile, managerAthletePreview)) return;

    const wBase = full.split("?")[0] ?? "";
    const rBase = pathname.split("?")[0] ?? "";
    if (wBase === rBase) return;

    router.replace(normalizeWebResumeHref(full) as Href);
  }, [pathname, profile, managerAthletePreview, storageReady, router]);

  return null;
}

export default function AppLayout() {
  const { session, loading, profile } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  useAndroidSessionsBackHandler(!!session && !loading);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  }
  if (!session) return <Redirect href="/(auth)/login" />;

  const pendingAthlete = profile?.role === "athlete" && profile?.approval_status === "pending";
  if (pendingAthlete && !isPendingPathname(pathname)) {
    return <Redirect href="/(app)/pending" />;
  }

  return (
    <>
      <WebAddressBarSync />
      <Stack
      screenOptions={{
        headerShown: true,
        headerTitle: "",
        headerLeft: () => <AppHeaderLeft />,
        headerRight: () => <AppHeaderRight />,
        headerShadowVisible: false,
        headerBackTitle: t("common.back"),
        // expo-router typed routes narrow header styles; runtime accepts full RN styles.
        headerStyle: headerStyle as object,
        headerTintColor: theme.colors.text,
        headerTitleStyle: headerTitleStyle as object,
      }}
    />
    </>
  );
}
