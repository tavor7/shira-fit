import { View, Text, Pressable, StyleSheet, Image } from "react-native";
import { router } from "expo-router";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

export default function PasswordUpdatedScreen() {
  const { language, t, isRTL } = useI18n();
  return (
    <View style={styles.container}>
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={[styles.title, isRTL && { textAlign: "right" }]}>{t("auth.passwordUpdated")}</Text>
      <Text style={[styles.body, isRTL && { textAlign: "right" }]}>
        {language === "he" ? "אפשר להתחבר עם הסיסמה החדשה." : "You can sign in with your new password."}
      </Text>
      <Pressable style={styles.btn} onPress={() => router.replace("/(auth)/login")} android_ripple={{ color: "rgba(255,255,255,0.3)" }}>
        <Text style={styles.btnText}>{t("auth.signIn")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.background },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 120, height: 120 },
  title: { fontSize: 22, fontWeight: "800", textAlign: "center", marginBottom: 12, color: theme.colors.text },
  body: { fontSize: 16, color: theme.colors.textMuted, textAlign: "center", marginBottom: 28 },
  btn: { backgroundColor: theme.colors.accent, padding: 16, borderRadius: theme.radius.md, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
