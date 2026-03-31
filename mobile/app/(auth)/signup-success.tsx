import { View, Text, Pressable, StyleSheet, ScrollView, Image } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { theme } from "../../src/theme";

/**
 * Shown after successful signup so users always see clear confirmation
 * (especially on web where Alert is easy to miss).
 */
export default function SignupSuccessScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();

  async function goLogin() {
    await supabase.auth.signOut();
    router.replace("/(auth)/login");
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.logoWrap}>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <View style={styles.card}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✓</Text>
        </View>
        <Text style={styles.title}>Request sent</Text>
        <Text style={styles.lead}>
          Your registration was received. Your account is <Text style={styles.em}>waiting for manager approval</Text>.
          The studio will contact you when you can book sessions.
        </Text>
        {email ? (
          <View style={styles.box}>
            <Text style={styles.boxLabel}>Registered email</Text>
            <Text style={styles.boxValue}>{email}</Text>
          </View>
        ) : null}
        <Text style={styles.note}>
          If email confirmation is turned on in your project, check your inbox and confirm before signing in.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          onPress={goLogin}
          android_ripple={{ color: "rgba(255,255,255,0.3)" }}
        >
          <Text style={styles.btnText}>Back to sign in</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.sm },
  logo: { width: 120, height: 120 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 28,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxWidth: 480,
    alignSelf: "center",
    width: "100%",
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.successBg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 20,
  },
  badgeText: { fontSize: 28, color: theme.colors.success, fontWeight: "800" },
  title: { fontSize: 24, fontWeight: "800", textAlign: "center", marginBottom: 12, color: theme.colors.text },
  lead: { fontSize: 16, lineHeight: 24, color: theme.colors.textMuted, textAlign: "center", marginBottom: 20 },
  em: { fontWeight: "700", color: theme.colors.text },
  box: {
    backgroundColor: theme.colors.surfaceElevated,
    padding: 14,
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  boxLabel: { fontSize: 12, color: theme.colors.textSoft, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  boxValue: { fontSize: 16, fontWeight: "600", color: theme.colors.text },
  note: { fontSize: 13, color: theme.colors.textSoft, textAlign: "center", marginBottom: 24, lineHeight: 20 },
  btn: { backgroundColor: theme.colors.cta, padding: 16, borderRadius: theme.radius.md, alignItems: "center" },
  btnPressed: { opacity: 0.9 },
  btnText: { color: theme.colors.ctaText, fontWeight: "700", fontSize: 16, letterSpacing: 0.2 },
});
