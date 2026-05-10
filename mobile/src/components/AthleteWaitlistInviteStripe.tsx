import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

const ACCENT = "#818cf8";
const ACCENT_SOFT = "rgba(129, 140, 248, 0.14)";
const ACCENT_BORDER = "rgba(129, 140, 248, 0.42)";

type InviteProps = {
  onPress: () => void;
  disabled?: boolean;
  joining?: boolean;
  /** Tighter padding for week grid cards */
  compact?: boolean;
};

/** Tappable “join waitlist” affordance for full sessions (athlete calendar / day sheet). */
export function AthleteWaitlistInviteStripe({ onPress, disabled, joining, compact }: InviteProps) {
  const { t, isRTL } = useI18n();
  function handlePress() {
    if (disabled || joining) return;
    if (Platform.OS === "ios" || Platform.OS === "android") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress();
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled || joining}
      style={({ pressed }) => [
        styles.inviteOuter,
        compact && styles.inviteOuterCompact,
        pressed && !disabled && !joining && styles.invitePressed,
        (disabled || joining) && styles.inviteDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${t("athleteCalendar.joinWaitlistCta")}. ${t("athleteCalendar.joinWaitlistSub")}`}
    >
      <View style={[styles.inviteRow, compact && styles.inviteRowCompact, isRTL && !compact && styles.inviteRowRtl]}>
        {compact ? (
          joining ? (
            <ActivityIndicator color={ACCENT} size="small" />
          ) : (
            <View style={styles.inviteStackCompact}>
              <Text
                style={styles.inviteLine1Compact}
                maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
                numberOfLines={1}
              >
                {t("athleteCalendar.joinWaitlistLine1")}
              </Text>
              <Text
                style={styles.inviteLine2Compact}
                maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
                numberOfLines={1}
              >
                {t("athleteCalendar.joinWaitlistLine2")}
              </Text>
            </View>
          )
        ) : (
          <>
            <View style={styles.inviteCopy}>
              <Text style={styles.inviteTitle} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
                {t("athleteCalendar.joinWaitlistCta")}
              </Text>
              <Text style={styles.inviteSub} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
                {t("athleteCalendar.joinWaitlistSub")}
              </Text>
            </View>
            {joining ? (
              <ActivityIndicator color={ACCENT} size="small" />
            ) : (
              <Text style={styles.inviteChevron} accessibilityElementsHidden importantForAccessibility="no">
                {isRTL ? "‹" : "›"}
              </Text>
            )}
          </>
        )}
      </View>
    </Pressable>
  );
}

type JoinedProps = { compact?: boolean };

export function AthleteWaitlistJoinedStripe({ compact }: JoinedProps) {
  const { t, isRTL } = useI18n();
  return (
    <View
      style={[styles.joinedOuter, compact && styles.joinedOuterCompact]}
      accessibilityRole="text"
      accessibilityLabel={t("athleteCalendar.onWaitlistStatus")}
    >
      <View style={[styles.joinedRow, compact && styles.joinedRowCompact, isRTL && !compact && styles.joinedRowRtl]}>
        {compact ? (
          <Text
            style={styles.joinedTxtCompact}
            maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
            numberOfLines={1}
            adjustsFontSizeToFit={Platform.OS !== "web"}
            minimumFontScale={0.8}
          >
            {t("athleteCalendar.onWaitlistCompact")}
          </Text>
        ) : (
          <>
            <Text style={styles.joinedMark} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
              ✓
            </Text>
            <Text style={styles.joinedTxt} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
              {t("athleteCalendar.onWaitlistStatus")}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inviteOuter: {
    marginTop: 8,
    borderRadius: theme.radius.sm,
    backgroundColor: ACCENT_SOFT,
    borderWidth: 1,
    borderColor: ACCENT_BORDER,
    overflow: "hidden",
  },
  inviteOuterCompact: { marginTop: 4 },
  invitePressed: { opacity: 0.92 },
  inviteDisabled: { opacity: 0.65 },
  inviteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  inviteRowCompact: {
    paddingVertical: 7,
    paddingHorizontal: 6,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 38,
  },
  inviteRowRtl: { flexDirection: "row-reverse" },
  inviteCopy: { flex: 1, minWidth: 0, gap: 2 },
  inviteStackCompact: { alignItems: "center", justifyContent: "center", gap: 1 },
  inviteLine1Compact: {
    color: theme.colors.textMuted,
    fontWeight: "800",
    fontSize: 9,
    lineHeight: 11,
    letterSpacing: 0.4,
    textAlign: "center",
  },
  inviteLine2Compact: {
    color: theme.colors.text,
    fontWeight: "900",
    fontSize: 11,
    lineHeight: 13,
    letterSpacing: 0.15,
    textAlign: "center",
  },
  inviteTitle: {
    color: theme.colors.text,
    fontWeight: "900",
    fontSize: 13,
    letterSpacing: 0.15,
  },
  inviteSub: {
    color: theme.colors.textMuted,
    fontWeight: "600",
    fontSize: 11,
    lineHeight: 14,
  },
  inviteChevron: {
    color: ACCENT,
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 24,
    marginTop: -2,
  },
  joinedOuter: {
    marginTop: 8,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.35)",
  },
  joinedOuterCompact: { marginTop: 4 },
  joinedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  joinedRowCompact: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
  joinedRowRtl: { flexDirection: "row-reverse" },
  joinedTxtCompact: {
    color: theme.colors.success,
    fontWeight: "800",
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
  },
  joinedMark: {
    color: theme.colors.success,
    fontWeight: "900",
    fontSize: 14,
  },
  joinedTxt: {
    flex: 1,
    color: theme.colors.success,
    fontWeight: "800",
    fontSize: 12,
    lineHeight: 16,
  },
});
