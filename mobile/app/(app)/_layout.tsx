import { Stack } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";
import { Redirect } from "expo-router";
import { AuthHeaderRight } from "../../src/components/AuthHeaderRight";
import { theme } from "../../src/theme";

export default function AppLayout() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (!session) return <Redirect href="/(auth)/login" />;
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerRight: () => <AuthHeaderRight />,
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: theme.colors.backgroundAlt,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.borderMuted,
        } as object,
        headerTintColor: theme.colors.text,
        headerTitleStyle: {
          fontWeight: "600",
          fontSize: 17,
          color: theme.colors.text,
          letterSpacing: 0.2,
        } as object,
      }}
    />
  );
}
