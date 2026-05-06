import { Stack } from "expo-router";
import Head from "expo-router/head";
import { AuthProvider } from "../src/context/AuthContext";
import { Platform, View, type TextStyle, type ViewStyle } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../src/theme";
import { StudioContactFooter } from "../src/components/StudioContactFooter";
import { I18nProvider } from "../src/context/I18nContext";
import { ManagerAthletePreviewProvider } from "../src/context/ManagerAthletePreviewContext";
import { ToastProvider } from "../src/context/ToastContext";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary";
import { initNotificationHandler } from "../src/lib/notificationsInit";
import { useEffect } from "react";
import * as Updates from "expo-updates";
import { useAuth } from "../src/context/AuthContext";

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

function StudioContactFooterGate() {
  const { profile } = useAuth();
  const role = profile?.role;
  const isStaff = role === "coach" || role === "manager";
  if (isStaff) return null;
  return <StudioContactFooter />;
}

export default function RootLayout() {
  useEffect(() => {
    if (__DEV__) return;
    if (Platform.OS === "web") return;
    (async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (!update.isAvailable) return;
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch {
        // ignore (offline, disabled updates, etc.)
      }
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        {Platform.OS === "web" ? (
          <Head>
            <meta name="color-scheme" content="dark light" />
            <style>{`
              :root { color-scheme: dark; }
              input[type="date"], input[type="time"] {
                color-scheme: dark;
              }
              /* Safari temporal inputs: normalize inner padding/height */
              ::-webkit-datetime-edit,
              ::-webkit-datetime-edit-fields-wrapper,
              ::-webkit-datetime-edit-text,
              ::-webkit-datetime-edit-minute-field,
              ::-webkit-datetime-edit-hour-field,
              ::-webkit-datetime-edit-meridiem-field,
              ::-webkit-datetime-edit-day-field,
              ::-webkit-datetime-edit-month-field,
              ::-webkit-datetime-edit-year-field {
                padding: 0;
              }
              input::-webkit-inner-spin-button { height: auto; }
              /* Remove legacy WebKit scrollbar arrow buttons (can look like stray ▼/◀/▶ on scroll areas). */
              ::-webkit-scrollbar-button {
                display: none;
                width: 0;
                height: 0;
              }
            `}</style>
          </Head>
        ) : null}
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
                  <StudioContactFooterGate />
                </ToastProvider>
              </AppErrorBoundary>
            </ManagerAthletePreviewProvider>
          </I18nProvider>
        </AuthProvider>
      </View>
    </SafeAreaProvider>
  );
}
