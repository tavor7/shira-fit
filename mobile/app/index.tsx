import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/context/AuthContext";
import { theme } from "../src/theme";

export default function Index() {
  const { session, profile, loading, refreshProfile } = useAuth();
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
    return <Redirect href="/(auth)/login" />;
  }
  if (profile.role === "athlete" && profile.approval_status === "pending")
    return <Redirect href="/(app)/pending" />;
  if (profile.role === "athlete")
    return <Redirect href="/(app)/athlete/sessions" />;
  if (profile.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  return <Redirect href="/(app)/manager/sessions" />;
}
