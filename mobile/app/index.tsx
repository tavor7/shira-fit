import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/context/AuthContext";
import { theme } from "../src/theme";

export default function Index() {
  const { session, profile, loading } = useAuth();
  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
      </View>
    );
  if (!session) return <Redirect href="/(auth)/login" />;
  if (!profile) return <Redirect href="/(auth)/login" />;
  if (profile.role === "athlete" && profile.approval_status === "pending")
    return <Redirect href="/(app)/pending" />;
  if (profile.role === "athlete")
    return <Redirect href="/(app)/athlete/sessions" />;
  if (profile.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  return <Redirect href="/(app)/manager/sessions" />;
}
