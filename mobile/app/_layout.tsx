import { Stack } from "expo-router";
import { AuthProvider } from "../src/context/AuthContext";
import { View, type TextStyle, type ViewStyle } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../src/theme";
import { StudioContactFooter } from "../src/components/StudioContactFooter";
import { I18nProvider } from "../src/context/I18nContext";
import { ManagerAthletePreviewProvider } from "../src/context/ManagerAthletePreviewContext";
import { ToastProvider } from "../src/context/ToastContext";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary";
import { initNotificationHandler } from "../src/lib/notificationsInit";

initNotificationHandler();

const rootHeaderStyle: ViewStyle = {
  backgroundColor: theme.colors.backgroundAlt,
  borderBottomWidth: 1,
  borderBottomColor: theme.colors.borderMuted,
};

const rootHeaderTitleStyle: TextStyle = {
  fontWeight: "600",
  fontSize: 17,
  color: theme.colors.text,
  letterSpacing: 0.2,
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <AuthProvider>
          <I18nProvider>
            <ManagerAthletePreviewProvider>
              <AppErrorBoundary>
                <ToastProvider>
                  <StatusBar style="light" />
                  <View style={{ flex: 1 }}>
                    <Stack
                      screenOptions={{
                        // Nested stacks (/(auth), /(app)) render their own headers as needed.
                        // Keeping the root header hidden avoids showing route-group titles like "(app)".
                        headerShown: false,
                        headerBackTitle: "Back",
                        headerShadowVisible: false,
                        headerStyle: rootHeaderStyle as object,
                        headerTintColor: theme.colors.text,
                        headerTitleStyle: rootHeaderTitleStyle as object,
                      }}
                    />
                  </View>
                  <StudioContactFooter />
                </ToastProvider>
              </AppErrorBoundary>
            </ManagerAthletePreviewProvider>
          </I18nProvider>
        </AuthProvider>
      </View>
    </SafeAreaProvider>
  );
}
