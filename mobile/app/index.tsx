import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useAuth } from "../src/context/AuthContext";
import { useManagerAthletePreview } from "../src/context/ManagerAthletePreviewContext";
import { theme } from "../src/theme";

export default function Index() {
  const { session, profile, loading, refreshProfile, signOut } = useAuth();
  const { enabled: managerAthletePreview, storageReady: athletePreviewStorageReady } = useManagerAthletePreview();
  const [profileRetrying, setProfileRetrying] = useState(false);
  const didRetry = useRef(false);

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

  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
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
  if (profile.role === "athlete")
    return <Redirect href="/(app)/athlete/sessions" />;
  if (profile.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  if (profile.role === "manager" && managerAthletePreview) return <Redirect href="/(app)/athlete/sessions" />;
  return <Redirect href="/(app)/manager/sessions" />;
}
