import { Stack, Redirect, usePathname, type Href } from "expo-router";
import { ActivityIndicator, Platform, Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { AppHeaderRight } from "../../src/components/AppHeaderRight";
import { AppHeaderLeft } from "../../src/components/AppHeaderLeft";
import { theme } from "../../src/theme";
import { useAndroidSessionsBackHandler } from "../../src/hooks/useAndroidSessionsBackHandler";
import { isPendingPathname } from "../../src/lib/sessionsHomeNavigation";
import { useI18n } from "../../src/context/I18nContext";
import { getLoginHrefWithOptionalRedirectWeb } from "../../src/lib/webLastRoute";

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

export default function AppLayout() {
  const { session, loading, profile, authUnavailable, retryAuthBootstrap } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  useAndroidSessionsBackHandler(!!session && !loading && !authUnavailable);

  if (loading) {
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
  if (pendingAthlete && !isPendingPathname(pathname)) {
    return <Redirect href="/(app)/pending" />;
  }

  return (
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
  );
}
