import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { initialsFromName } from "../lib/managerDirectMessages";
import { readableOn } from "./UserAvatar";
import {
  getManagerMessageThemeStyle,
  type ManagerMessageTheme,
} from "../lib/managerMessageThemes";

type Props = {
  messageTheme: ManagerMessageTheme;
  senderName: string;
  body: string;
  inboxKicker: string;
  isRTL?: boolean;
  previewLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Payment reminder: the amount, large, above the message. */
  amountLabel?: string;
  /** Replaces `body` when the text needs inline emphasis. */
  bodyContent?: ReactNode;
  hideKickerEmoji?: boolean;
  /** Overrides the initials taken from the sender's name. */
  avatarLabel?: string;
};

/** Shared card UI for recipient modal and manager live preview. */
export function ManagerMessageCard({
  messageTheme,
  senderName,
  body,
  inboxKicker,
  isRTL,
  previewLabel,
  style,
  amountLabel,
  bodyContent,
  hideKickerEmoji,
  avatarLabel,
}: Props) {
  const palette = getManagerMessageThemeStyle(messageTheme);
  const senderLabel = senderName.trim() || "Studio";
  const displayBody = body.trim() || "…";
  const avatarInitials = avatarLabel ?? initialsFromName(senderLabel);

  return (
    <View style={[styles.wrap, style]}>
      {previewLabel ? (
        <AppText variant="caption" muted isRTL={isRTL} style={styles.previewLabel}>
          {previewLabel}
        </AppText>
      ) : null}
      <View style={[styles.card, { borderColor: palette.cardBorder }]}>
        <View style={[styles.headerGlow, { backgroundColor: palette.glowPrimary }]} />
        <View style={[styles.headerGlowSecondary, { backgroundColor: palette.glowSecondary }]} />
        <View style={styles.header}>
          <View style={[styles.avatarRing, { backgroundColor: palette.avatarRing }]}>
            <View style={[styles.avatar, { backgroundColor: palette.avatarBg }]}>
              <AppText variant="title" style={[styles.avatarTxt, { color: readableOn(palette.avatarBg) }]}>
                {avatarInitials}
              </AppText>
            </View>
          </View>
          <AppText variant="caption" isRTL={isRTL} style={[styles.kicker, { color: palette.kickerColor }]}>
            {hideKickerEmoji ? inboxKicker : `${palette.emoji} ${inboxKicker}`}
          </AppText>
          <AppText variant="headline" isRTL={isRTL} style={styles.senderName}>
            {senderLabel}
          </AppText>
        </View>
        <View style={styles.bubbleWrap}>
          <View
            style={[
              styles.bubble,
              isRTL && styles.bubbleRtl,
              { backgroundColor: palette.bubbleBg, borderColor: palette.bubbleBorder },
            ]}
          >
            {amountLabel ? (
              <AppText variant="display" style={styles.amount}>
                {amountLabel}
              </AppText>
            ) : null}
            <AppText variant="body" isRTL={isRTL} style={[styles.bubbleText, { color: palette.bubbleText }]}>
              {bodyContent ?? displayBody}
            </AppText>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%" },
  previewLabel: {
    marginBottom: theme.spacing.sm,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  card: {
    width: "100%",
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    overflow: "hidden",
    paddingBottom: theme.spacing.md,
  },
  headerGlow: {
    position: "absolute",
    top: -40,
    left: -20,
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  headerGlowSecondary: {
    position: "absolute",
    top: -10,
    right: -30,
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  header: {
    alignItems: "center",
    paddingTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: 4,
  },
  avatarRing: {
    padding: 3,
    borderRadius: theme.radius.full,
    marginBottom: theme.spacing.sm,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: {
    ...theme.typography.headline,
    color: "#fff",
    letterSpacing: 0.5,
  },
  kicker: {
    textTransform: "uppercase",
    letterSpacing: 1.1,
    fontWeight: "800",
    fontSize: 11,
  },
  senderName: {
    textAlign: "center",
    color: theme.colors.text,
  },
  bubbleWrap: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  bubble: {
    borderRadius: theme.radius.lg,
    borderTopLeftRadius: 6,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
  },
  bubbleRtl: {
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: 6,
  },
  bubbleText: {
    lineHeight: 22,
  },
  amount: {
    textAlign: "center",
    fontSize: 32,
    lineHeight: 36,
    color: theme.colors.text,
    fontVariant: ["tabular-nums"],
    marginBottom: theme.spacing.sm,
  },
});
