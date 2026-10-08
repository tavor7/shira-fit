import { Stack } from "expo-router";
import Head from "expo-router/head";
import { AuthProvider } from "../src/context/AuthContext";
import { Platform, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BottomChromeProvider } from "../src/context/BottomChromeContext";
import { theme } from "../src/theme";
import { appHeaderStyle, appHeaderTitleStyle } from "../src/theme/headerStyles";
import { StudioContactFooter } from "../src/components/StudioContactFooter";
import { I18nProvider } from "../src/context/I18nContext";
import { ManagerAthletePreviewProvider } from "../src/context/ManagerAthletePreviewContext";
import { ToastProvider } from "../src/context/ToastContext";
import { BulkJobsProvider } from "../src/context/BulkJobsContext";
import { AppAlertProvider } from "../src/context/AppAlertContext";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary";
import { AccessibilityProvider } from "../src/context/AccessibilityContext";
import { AccessibilityStyleInjector } from "../src/components/AccessibilityStyleInjector";
import { AccessibilityMenu } from "../src/components/AccessibilityMenu";
import { RouteRestoreDebugPanel } from "../src/components/RouteRestoreDebugPanel";
import { WebLastRouteTracker } from "../src/components/WebLastRouteTracker";
import { initNotificationHandler } from "../src/lib/notificationsInit";
import { useEffect } from "react";
import * as Updates from "expo-updates";
import { useAuth } from "../src/context/AuthContext";
import { OfflineNotice } from "../src/components/OfflineNotice";

initNotificationHandler();

const rootHeaderStyle = appHeaderStyle;
const rootHeaderTitleStyle = appHeaderTitleStyle;

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
      <BottomChromeProvider>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        {Platform.OS === "web" ? (
          <Head>
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
            />
            <meta name="color-scheme" content="dark light" />
            <style>{`
              :root { color-scheme: dark; }
              /*
                iOS Safari auto-zooms form controls when their computed font-size is < 16px.
                This is especially noticeable for temporal inputs (date/time) and makes the UI
                feel like it "randomly zooms" while typing/selecting values.
              */
              @supports (-webkit-touch-callout: none) {
                input,
                select,
                textarea,
                button {
                  font-size: 16px !important;
                }
              }
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
              /*
                react-native-web renders Pressable as a button/div, so tapping one leaves the
                browser's default focus ring showing (a blue outline) until focus moves elsewhere.
                Drop it for pointer/touch-triggered focus but keep it for real keyboard navigation.
              */
              button:focus:not(:focus-visible),
              [role="button"]:focus:not(:focus-visible) {
                outline: none;
              }
              /*
                Search fields: the field shell shows focus (the whole 48px control), not a second ring
                around the inner input. The enhanced-focus accessibility mode (!important) still applies.
              */
              [data-search-input]:focus { outline: none; }
              [data-search-shell]:focus-within { border-color: ${theme.colors.text}; }
              /*
                react-native-web renders every root <Text> with dir="auto", so each paragraph took its
                direction from its first letter: a Hebrew name turned an English row right-to-left (and
                reversed its times), and number-only text sat left-aligned inside Hebrew cards. Paragraphs
                follow the UI language (<html dir>) instead; embedded values keep their own order through
                the display helpers in src/lib/displayFormat.ts. :where() keeps this at zero specificity, so
                explicit writingDirection styles still win, and inputs keep dir="auto" for typed text. Text that shows
                user content on its own (userContentTextProps) also keeps dir="auto".
              */
              :where([dir="auto"]:not(input):not(textarea):not([data-bidi="content"])) {
                direction: inherit;
              }
            `}</style>
          </Head>
        ) : null}
        <AuthProvider>
          <I18nProvider>
            <AccessibilityProvider>
            <AppAlertProvider>
            <ManagerAthletePreviewProvider>
              <AppErrorBoundary>
                <ToastProvider>
                  <BulkJobsProvider>
                    {Platform.OS === "web" ? <WebLastRouteTracker /> : null}
                    {Platform.OS === "web" && __DEV__ ? <RouteRestoreDebugPanel /> : null}
                    {Platform.OS === "web" ? <AccessibilityStyleInjector /> : null}
                    {Platform.OS === "web" ? <AccessibilityMenu /> : null}
                    <OfflineNotice />
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
                          contentStyle: { backgroundColor: theme.colors.backgroundAlt },
                          // Auth<->app group swap isn't a drill-in — a fade reads better than a lateral slide.
                          animation: "fade",
                        }}
                      />
                    </View>
                    <StudioContactFooterGate />
                  </BulkJobsProvider>
                </ToastProvider>
              </AppErrorBoundary>
            </ManagerAthletePreviewProvider>
            </AppAlertProvider>
            </AccessibilityProvider>
          </I18nProvider>
        </AuthProvider>
      </View>
      </BottomChromeProvider>
    </SafeAreaProvider>
  );
}
