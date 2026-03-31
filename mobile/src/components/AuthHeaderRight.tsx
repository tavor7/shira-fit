import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { theme } from "../theme";
import { router } from "expo-router";
import { useI18n } from "../context/I18nContext";

function formatRole(role: string | undefined) {
  if (!role) return "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function AuthHeaderRight() {
  const { profile, signOut, loading } = useAuth();
  const { t, isRTL } = useI18n();

  const name = profile?.full_name || profile?.username || t("common.account");
  const role = formatRole(profile?.role);

  return (
    <View style={[styles.wrap, isRTL && styles.wrapRTL]}>
      <View style={styles.nameBlock}>
        <Text style={styles.name} numberOfLines={1}>
          {loading ? "…" : name}
        </Text>
        {role ? (
          <Text style={styles.rolePill} numberOfLines={1}>
            {role}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => router.push("/(app)/profile")}
        disabled={loading}
        style={({ pressed }) => [styles.chip, pressed && !loading && styles.chipPressed]}
      >
        <Text style={styles.chipTxt}>{t("header.profile")}</Text>
      </Pressable>
      <Pressable
        onPress={signOut}
        disabled={loading}
        style={({ pressed }) => [styles.chipMuted, pressed && !loading && styles.chipPressed]}
      >
        <Text style={styles.chipTxtMuted}>{t("header.logout")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    justifyContent: "flex-end",
    flexWrap: "wrap",
    maxWidth: 300,
  },
  wrapRTL: { flexDirection: "row-reverse" },
  nameBlock: { maxWidth: 120, marginRight: 2 },
  name: { fontSize: 12, fontWeight: "700", color: theme.colors.text, letterSpacing: 0.2 },
  rolePill: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  chipMuted: {
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipPressed: { opacity: 0.88 },
  chipTxt: { color: theme.colors.ctaText, fontWeight: "700", fontSize: 11, letterSpacing: 0.3 },
  chipTxtMuted: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 10, letterSpacing: 0.2 },
});
