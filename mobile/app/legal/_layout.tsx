import { Stack } from "expo-router";
import { theme } from "../../src/theme";
import { AuthHeaderLeft } from "../../src/components/AuthHeaderLeft";

/**
 * Reachable regardless of auth state (sibling to (auth)/(app), not nested inside either),
 * so signed-out visitors on signup/login and signed-in users can both open these pages.
 */
export default function LegalLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTitle: "",
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: theme.colors.backgroundAlt,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.borderMuted,
        } as object,
        headerTintColor: theme.colors.text,
        headerLeft: () => <AuthHeaderLeft />,
      }}
    />
  );
}
