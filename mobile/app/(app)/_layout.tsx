import { Stack, Redirect, usePathname } from "expo-router";
import { ActivityIndicator, View, type TextStyle, type ViewStyle } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { AppHeaderRight } from "../../src/components/AppHeaderRight";
import { AppHeaderLeft } from "../../src/components/AppHeaderLeft";
import { theme } from "../../src/theme";
import { useAndroidSessionsBackHandler } from "../../src/hooks/useAndroidSessionsBackHandler";
import { isPendingPathname } from "../../src/lib/sessionsHomeNavigation";

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
  const { session, loading, profile } = useAuth();
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
    <Stack
      screenOptions={{
        headerShown: true,
        // Don't show route names like "manager/sessions" in the header.
        headerTitle: "",
        headerLeft: () => <AppHeaderLeft />,
        headerRight: () => <AppHeaderRight />,
        headerShadowVisible: false,
        // expo-router typed routes narrow header styles; runtime accepts full RN styles.
        headerStyle: headerStyle as object,
        headerTintColor: theme.colors.text,
        headerTitleStyle: headerTitleStyle as object,
      }}
    />
  );
}
