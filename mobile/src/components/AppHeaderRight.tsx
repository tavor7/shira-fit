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
 * Right side of the app header: compact identity + profile + log out (language & athlete preview live in the menu).
 */
export function AppHeaderRight() {
  const { profile, loading, signOut } = useAuth();
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
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
          {loading ? "…" : name}
        </Text>
        {roleLine ? (
          <Text style={styles.role} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
            {roleLine}
          </Text>
        ) : null}
      </View>
      {/* Keep Profile + Log out on one row — wrapping stacked them and overlapped page content on narrow web / athlete preview. */}
      <View style={styles.chipsRow}>
        <Pressable
          onPress={() => router.push("/(app)/profile")}
          disabled={loading || pendingAthlete}
          accessibilityRole="button"
          accessibilityLabel={t("header.profile")}
          style={({ pressed }) => [styles.chip, (pressed && !loading && !pendingAthlete) && styles.pressed, pendingAthlete && { opacity: 0.45 }]}
        >
          <Text style={styles.chipTxt} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
            {t("header.profile")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void signOut()}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel={t("header.logout")}
          style={({ pressed }) => [styles.chipMuted, pressed && !loading && styles.pressed]}
        >
          <Text style={styles.chipMutedTxt} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
            {t("header.logout")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    justifyContent: "flex-end",
    gap: 8,
    paddingVertical: 2,
    minWidth: 0,
    flex: 1,
    /** Match left cluster: logical horizontal inset on both sides (fixes RTL / web `dir=rtl`). */
    paddingStart: theme.spacing.sm,
    paddingEnd: theme.spacing.sm,
  },
  wrapRTL: { flexDirection: "row-reverse", justifyContent: "flex-start" },
  nameBlock: {
    flex: 1,
    alignItems: "flex-end",
    marginEnd: 4,
    minWidth: 0,
    maxWidth: "100%",
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  chipTxt: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 12, letterSpacing: 0.15 },
  chipMuted: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  chipMutedTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 11, letterSpacing: 0.1 },
  pressed: { opacity: 0.88 },
});
