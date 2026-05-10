import { Redirect } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useAuth } from "../src/context/AuthContext";
import { useManagerAthletePreview } from "../src/context/ManagerAthletePreviewContext";
import { useI18n } from "../src/context/I18nContext";
import { theme } from "../src/theme";
import { ROUTE_RESTORE_DEBUG_KEY_INDEX, recordIndexRouteRestoreDebug } from "../src/lib/routeRestoreDebug";
import { canRoleAccessWebPath, readWebLastRoute, webPublicPathToExpoHref } from "../src/lib/webLastRoute";
import { logRedirectToManagerSessions } from "../src/lib/managerSessionsRedirectLog";

/**
 * Entry route for `/` only. After auth + profile are ready, web clients may be sent to the last saved
 * in-app path (see `webLastRoute` + `WebLastRouteTracker`); otherwise we redirect to the role home.
 */
export default function Index() {
  const { t } = useI18n();
  const { session, profile, loading, refreshProfile, signOut, authUnavailable, retryAuthBootstrap } = useAuth();
  const { enabled: managerAthletePreview, storageReady: athletePreviewStorageReady } = useManagerAthletePreview();
  const [profileRetrying, setProfileRetrying] = useState(false);
  const didRetry = useRef(false);
  const didLogIndexManagerDefault = useRef(false);
  /**
   * Web/PWA: defer role-default redirect until after layout + one frame so `session.user.id` and
   * `localStorage` are stable after tab resume, then read saved route before choosing default.
   */
  const [webIndexRestoreReady, setWebIndexRestoreReady] = useState(() => Platform.OS !== "web");

  useLayoutEffect(() => {
    if (Platform.OS !== "web") {
      setWebIndexRestoreReady(true);
      return;
    }
    setWebIndexRestoreReady(false);
    if (loading || !session?.user?.id || !profile) return;
    if (profile.role === "manager" && !athletePreviewStorageReady) return;
    if (profile.role === "athlete" && profile.approval_status === "pending") {
      setWebIndexRestoreReady(true);
      return;
    }
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setWebIndexRestoreReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [loading, session?.user?.id, profile, athletePreviewStorageReady]);

  useEffect(() => {
    if (loading) return;
    if (!session) return;
    if (profile) return;
    if (didRetry.current) return;
    didRetry.current = true;
    setProfileRetrying(true);
    refreshProfile()
      .catch(() => undefined)
      .finally(() => setProfileRetrying(false));
  }, [loading, session, profile, refreshProfile]);

  useEffect(() => {
    if (Platform.OS === "web" && !webIndexRestoreReady) {
      try {
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(
            ROUTE_RESTORE_DEBUG_KEY_INDEX,
            JSON.stringify({
              t: new Date().toISOString(),
              decision: "waiting_index_web_restore_gate",
              indexLocationPathname: typeof window !== "undefined" ? window.location.pathname : "",
            })
          );
        }
      } catch {
        /* ignore */
      }
      return;
    }
    recordIndexRouteRestoreDebug({
      loading,
      authUnavailable: !!authUnavailable,
      sessionUserId: session?.user?.id,
      profile,
      athletePreviewStorageReady,
      managerAthletePreview,
      profileRetrying,
    });
  }, [
    loading,
    authUnavailable,
    session?.user?.id,
    profile,
    athletePreviewStorageReady,
    managerAthletePreview,
    profileRetrying,
    webIndexRestoreReady,
  ]);

  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
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
  if (!session) return <Redirect href="/(auth)/login" />;
  if (!profile) {
    // Session exists but profile fetch may be briefly stale after approval changes.
    // Retry once before sending user back to login.
    if (profileRetrying)
      return (
        <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
          <ActivityIndicator size="large" color={theme.colors.cta} />
        </View>
      );
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: theme.spacing.lg,
          backgroundColor: theme.colors.background,
        }}
      >
        <Text style={{ color: theme.colors.text, fontWeight: "900", fontSize: 18, textAlign: "center" }}>
          Profile unavailable
        </Text>
        <Text style={{ marginTop: 10, color: theme.colors.textMuted, fontWeight: "700", textAlign: "center", maxWidth: 320 }}>
          Your login session is active, but we couldn’t load your profile. This is usually a network issue or a missing database row after signup.
        </Text>
        <View style={{ marginTop: 18, gap: 10, width: "100%", maxWidth: 320 }}>
          <Pressable
            onPress={async () => {
              setProfileRetrying(true);
              try {
                await refreshProfile();
              } finally {
                setProfileRetrying(false);
              }
            }}
            style={({ pressed }) => [
              {
                paddingVertical: 12,
                borderRadius: theme.radius.full,
                backgroundColor: theme.colors.cta,
                alignItems: "center",
              },
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={{ color: theme.colors.ctaText, fontWeight: "900" }}>Retry</Text>
          </Pressable>
          <Pressable
            onPress={signOut}
            style={({ pressed }) => [
              {
                paddingVertical: 12,
                borderRadius: theme.radius.full,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.borderMuted,
                alignItems: "center",
              },
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={{ color: theme.colors.textMuted, fontWeight: "900" }}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (profile.role === "manager" && !athletePreviewStorageReady) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  }
  if (profile.role === "athlete" && profile.approval_status === "pending")
    return <Redirect href="/(app)/pending" />;

  if (Platform.OS === "web" && !webIndexRestoreReady) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  }

  if (Platform.OS === "web") {
    const saved = readWebLastRoute(session.user.id);
    if (saved && canRoleAccessWebPath(profile.role, saved, { managerAthletePreview })) {
      return <Redirect href={webPublicPathToExpoHref(saved)} />;
    }
  }

  if (profile.role === "athlete")
    return <Redirect href="/(app)/athlete/sessions" />;
  if (profile.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  if (profile.role === "manager" && managerAthletePreview) return <Redirect href="/(app)/athlete/sessions" />;
  if (!didLogIndexManagerDefault.current) {
    didLogIndexManagerDefault.current = true;
    logRedirectToManagerSessions("app/index.tsx", "index_role_default_manager", {
      authLoading: loading,
      authUserId: session?.user?.id ?? null,
      profileRole: profile.role,
    });
  }
  return <Redirect href="/(app)/manager/sessions" />;
}
