import { Stack } from "expo-router";
import { theme } from "../../src/theme";
import { AuthHeaderLeft } from "../../src/components/AuthHeaderLeft";

export default function AuthLayout() {
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
        // Screens that do not fill the width (centred columns on desktop) sit on the app background, never the navigator default.
        contentStyle: { backgroundColor: theme.colors.backgroundAlt },
      }}
    />
  );
}
