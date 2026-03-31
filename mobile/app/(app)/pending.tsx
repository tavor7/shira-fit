import { Redirect, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { View, Text, StyleSheet, Image } from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { theme } from "../../src/theme";

export default function PendingScreen() {
  const { profile, refreshProfile } = useAuth();

  useFocusEffect(
    useCallback(() => {
      refreshProfile().catch(() => undefined);
    }, [refreshProfile])
  );

  // If approval status changed, don't let the user get stuck here.
  if (profile?.role === "athlete" && profile.approval_status === "approved") {
    return <Redirect href="/(app)/athlete/sessions" />;
  }
  if (profile?.role === "coach") return <Redirect href="/(app)/coach/sessions" />;
  if (profile?.role === "manager") return <Redirect href="/(app)/manager/sessions" />;

  return (
    <View style={styles.box}>
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>Pending approval</Text>
        <Text style={styles.body}>
          Hi {profile?.full_name || profile?.username}. A manager will contact you by phone before you can book sessions.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.lg },
  logo: { width: 120, height: 120 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  title: { fontSize: 22, fontWeight: "700", marginBottom: theme.spacing.sm, color: theme.colors.text, letterSpacing: 0.2 },
  body: { fontSize: 16, color: theme.colors.textMuted, lineHeight: 24 },
});
