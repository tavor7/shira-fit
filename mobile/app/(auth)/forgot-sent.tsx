import { View, Text, Pressable, StyleSheet, Image } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

export default function ForgotSentScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { language, t, isRTL } = useI18n();

  return (
    <View style={styles.container}>
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={[styles.title, isRTL && { textAlign: "right" }]}>{t("auth.checkEmail")}</Text>
      <Text style={[styles.body, isRTL && { textAlign: "right" }]}>
        {language === "he"
          ? `אם קיים חשבון${email ? ` עבור ${email}` : ""}, שלחנו קישור לאיפוס סיסמה. פתחו אותו במכשיר הזה ואז בחרו סיסמה חדשה.`
          : `If an account exists${email ? ` for ${email}` : ""}, we sent a password reset link. Open it on this device, then choose a new password.`}
      </Text>
      <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.9 }]} onPress={() => router.replace("/(auth)/login")} android_ripple={{ color: "rgba(255,255,255,0.3)" }}>
        <Text style={styles.btnText}>{language === "he" ? "חזרה להתחברות" : "Back to sign in"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.background },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 120, height: 120 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 16, textAlign: "center", color: theme.colors.text },
  body: { fontSize: 16, lineHeight: 24, color: theme.colors.textMuted, textAlign: "center", marginBottom: 28 },
  btn: { backgroundColor: theme.colors.accent, padding: 16, borderRadius: theme.radius.md, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
