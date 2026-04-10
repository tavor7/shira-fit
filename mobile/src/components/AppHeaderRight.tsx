import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";

function formatRole(role: string | undefined) {
  if (!role) return "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Right side of the app header: compact identity + profile + logout (language & athlete preview live in the menu).
 */
export function AppHeaderRight() {
  const { profile, signOut, loading } = useAuth();
  const { t, isRTL, language } = useI18n();
  const { enabled: athletePreview } = useManagerAthletePreview();

  const name = profile?.full_name || profile?.username || t("common.account");
  const pendingAthlete = profile?.role === "athlete" && profile?.approval_status === "pending";
  const baseRole = formatRole(profile?.role);
  const roleLine =
    profile?.role === "manager" && athletePreview
      ? language === "he"
        ? "מנהל · תצוגת מתאמן"
        : "Manager · Athlete view"
      : baseRole;

  return (
    <View style={[styles.wrap, isRTL && styles.wrapRTL]}>
      <View style={styles.nameBlock}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
          {loading ? "…" : name}
        </Text>
        {roleLine ? (
          <Text style={styles.role} numberOfLines={1} ellipsizeMode="tail">
            {roleLine}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => router.push("/(app)/profile")}
        disabled={loading || pendingAthlete}
        style={({ pressed }) => [styles.chip, (pressed && !loading && !pendingAthlete) && styles.pressed, pendingAthlete && { opacity: 0.45 }]}
      >
        <Text style={styles.chipTxt} numberOfLines={1}>
          {t("header.profile")}
        </Text>
      </Pressable>
      <Pressable
        onPress={signOut}
        disabled={loading}
        style={({ pressed }) => [styles.chipMuted, pressed && !loading && styles.pressed]}
      >
        <Text style={styles.chipMutedTxt} numberOfLines={1}>
          {t("header.logout")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: 300,
    gap: 6,
    paddingVertical: 2,
    minWidth: 0,
    /** Match left cluster: logical horizontal inset on both sides (fixes RTL / web `dir=rtl`). */
    paddingStart: theme.spacing.md,
    paddingEnd: theme.spacing.md,
  },
  wrapRTL: { flexDirection: "row-reverse", justifyContent: "flex-start" },
  nameBlock: {
    alignItems: "flex-end",
    marginEnd: 4,
    maxWidth: 140,
    minWidth: 0,
  },
  name: {
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.15,
  },
  role: {
    marginTop: 1,
    fontSize: 9,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
  },
  chipTxt: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 10, letterSpacing: 0.15 },
  chipMuted: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  chipMutedTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 9, letterSpacing: 0.1 },
  pressed: { opacity: 0.88 },
});
