import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import { isAthleteAccountDisabled } from "../lib/profileAccount";
import { userContentTextProps } from "../lib/layoutDirection";

/**
 * Right side of the app header: compact identity + profile + log out (language & athlete preview live in the menu).
 */
export function AppHeaderRight() {
  const { profile, loading, signOut } = useAuth();
  const { t, isRTL, rowFlip } = useI18n();
  const { enabled: athletePreview } = useManagerAthletePreview();

  const name = profile?.full_name || profile?.username || t("common.account");
  const pendingAthlete = profile?.role === "athlete" && profile?.approval_status === "pending";
  const blockedAthlete = pendingAthlete || isAthleteAccountDisabled(profile);
  const baseRole = profile?.role ? t(`roles.${profile.role}`) : "";
  const roleLine = profile?.role === "manager" && athletePreview ? t("header.managerAthleteView") : baseRole;

  const isNative = Platform.OS !== "web";

  return (
    <View
      style={[
        styles.wrap,
        // Native's headerRight is a bar button item sized by intrinsic content (auto layout),
        // not stretched across a full-width flex row like on web — `flex: 1` / `minWidth: 0`
        // there has no parent extent to grow into or shrink against, so the row hugs its
        // content instead, letting name text + chips render at their natural size.
        isNative && { flex: 0, minWidth: undefined },
        // Direction compensations apply only when rows are flipped manually (see lib/layoutDirection);
        // on web, <html dir> already places Profile beside the name and Log out at the screen edge.
        rowFlip && styles.wrapRTL,
        isRTL && styles.wrapRtlSpacing,
      ]}
    >
      <View style={[styles.nameBlock, isNative && { flex: 0, minWidth: undefined, maxWidth: undefined }, rowFlip && styles.nameBlockRtl]}>
        <Text
          {...userContentTextProps}
          style={[styles.name, rowFlip && styles.nameRtl]}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
        >
          {loading ? "…" : name}
        </Text>
        {roleLine ? (
          <Text
            style={[styles.role, rowFlip && styles.roleRtl]}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
          >
            {roleLine}
          </Text>
        ) : null}
      </View>
      {/* Keep Profile + Log out on one row — wrapping stacked them and overlapped page content on narrow web / athlete preview. */}
      <View style={[styles.chipsRow, rowFlip && styles.chipsRowRtl]}>
        <Pressable
          onPress={() => router.push("/(app)/profile")}
          hitSlop={2}
          disabled={loading || blockedAthlete}
          accessibilityRole="button"
          accessibilityLabel={t("header.profile")}
          style={({ pressed }) => [styles.chip, (pressed && !loading && !blockedAthlete) && styles.pressed, blockedAthlete && { opacity: 0.45 }]}
        >
          <Text style={styles.chipTxt} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
            {t("header.profile")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void signOut()}
          hitSlop={2}
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
  /** Slightly more air between name block and chips in Hebrew / RTL headers. */
  wrapRtlSpacing: { gap: 10 },
  nameBlock: {
    flex: 1,
    alignItems: "flex-end",
    marginEnd: 4,
    minWidth: 0,
    maxWidth: "100%",
  },
  /** Align identity lines toward the center gap so RTL labels don’t hug the wrong edge. */
  nameBlockRtl: {
    alignItems: "flex-start",
    marginEnd: 0,
    marginStart: 6,
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  /** Logout outermost (screen edge); Profile toward name — matches common RTL patterns. */
  chipsRowRtl: { flexDirection: "row-reverse", gap: 8 },
  name: {
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.15,
  },
  nameRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch" },
  role: {
    marginTop: 1,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  roleRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch" },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.controls.minTouch,
    minWidth: theme.controls.minTouch,
  },
  chipTxt: { color: theme.colors.text, ...theme.typography.label, letterSpacing: 0.15 },
  chipMuted: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.controls.minTouch,
    minWidth: theme.controls.minTouch,
  },
  chipMutedTxt: { color: theme.colors.textMuted, ...theme.typography.label, letterSpacing: 0.1 },
  pressed: { opacity: 0.88 },
});
