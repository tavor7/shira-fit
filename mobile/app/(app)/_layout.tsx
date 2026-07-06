import { Stack, Redirect, usePathname, type Href } from "expo-router";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { AppHeaderRight } from "../../src/components/AppHeaderRight";
import { AppHeaderLeft } from "../../src/components/AppHeaderLeft";
import { theme } from "../../src/theme";
import { appHeaderStyle, appHeaderTitleStyle } from "../../src/theme/headerStyles";
import { useAndroidSessionsBackHandler } from "../../src/hooks/useAndroidSessionsBackHandler";
import { isPendingPathname, isDisabledPathname } from "../../src/lib/sessionsHomeNavigation";
import { isAthleteAccountDisabled } from "../../src/lib/profileAccount";
import { useI18n } from "../../src/context/I18nContext";
import { ConsentGateModal } from "../../src/components/ConsentGateModal";
import { AddressGateModal } from "../../src/components/AddressGateModal";
import { ManagerDirectMessageModal } from "../../src/components/ManagerDirectMessageModal";
import { getLoginHrefWithOptionalRedirectWeb } from "../../src/lib/webLastRoute";
import { useManagerAthletePreview } from "../../src/context/ManagerAthletePreviewContext";
import { canRoleAccessAppPath, getRoleAccessDeniedRedirect } from "../../src/lib/roleRouteAccess";

const headerStyle = appHeaderStyle;
const headerTitleStyle = appHeaderTitleStyle;

export default function AppLayout() {
  const { session, loading, profile, authUnavailable, retryAuthBootstrap } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  const { enabled: managerAthletePreview, storageReady: managerPreviewStorageReady } = useManagerAthletePreview();
  useAndroidSessionsBackHandler(!!session && !loading && !authUnavailable);

  /**
   * Gate on `!session`, not on `loading` alone: profile/token refresh can set `loading` briefly for a
   * new user id, but same-user refresh must **not** swap this layout for a spinner — that unmounted
   * the entire Stack and reset navigation on web while the URL stayed on deep routes. Native benefits
   * too (no full-screen flash on refresh). `WebLastRouteTracker` is web-only; this layout runs on all platforms.
   */
  if (loading && !session) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  }
  if (authUnavailable) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: theme.spacing.lg,
          backgroundColor: theme.colors.background,
          gap: 16,
        }}
      >
        <Text style={{ color: theme.colors.text, fontWeight: "800", fontSize: 17, textAlign: "center" }}>
          {t("auth.bootstrapUnavailable")}
        </Text>
        <Pressable
          onPress={() => void retryAuthBootstrap()}
          style={({ pressed }) => [
            {
              paddingVertical: 12,
              paddingHorizontal: 22,
              borderRadius: theme.radius.full,
              backgroundColor: theme.colors.cta,
            },
            pressed && { opacity: 0.9 },
          ]}
        >
          <Text style={{ color: theme.colors.ctaText, fontWeight: "900" }}>{t("auth.retryConnection")}</Text>
        </Pressable>
      </View>
    );
  }
  if (!session) {
    const loginHref: Href = Platform.OS === "web" ? getLoginHrefWithOptionalRedirectWeb() : "/(auth)/login";
    return <Redirect href={loginHref} />;
  }

  const pendingAthlete = profile?.role === "athlete" && profile?.approval_status === "pending";
  const disabledAthlete = isAthleteAccountDisabled(profile);
  if (disabledAthlete && !isDisabledPathname(pathname)) {
    return <Redirect href="/(app)/disabled" />;
  }
  if (pendingAthlete && !isPendingPathname(pathname)) {
    return <Redirect href="/(app)/pending" />;
  }

  const role = profile?.role;
  const roleRouteGateReady = role !== "manager" || managerPreviewStorageReady || Platform.OS === "web";
  if (role && roleRouteGateReady && !canRoleAccessAppPath(role, pathname, { managerAthletePreview })) {
    return <Redirect href={getRoleAccessDeniedRedirect(role, managerAthletePreview)} />;
  }

  return (
    <>
      <ConsentGateModal />
      <AddressGateModal />
      <ManagerDirectMessageModal />
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
