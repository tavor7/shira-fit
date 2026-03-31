import { Stack } from "expo-router";
import { AuthProvider } from "../src/context/AuthContext";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../src/theme";
import { StudioContactFooter } from "../src/components/StudioContactFooter";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <AuthProvider>
          <StatusBar style="light" />
          <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerShown: true,
                headerBackTitle: "Back",
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
          </View>
          <StudioContactFooter />
        </AuthProvider>
      </View>
    </SafeAreaProvider>
  );
}
