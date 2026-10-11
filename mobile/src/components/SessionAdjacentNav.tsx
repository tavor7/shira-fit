import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, Platform, type ViewStyle } from "react-native";
import { useBottomChrome, useReportBottomBar } from "../context/BottomChromeContext";
import { LAYOUT, barBottomInset } from "../lib/screenLayout";
import * as Haptics from "expo-haptics";
import { router, type Href } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import {
  getAthleteAdjacentSessionIds,
  getStaffAdjacentSessionIds,
  type AdjacentSessionIds,
} from "../lib/sessionAdjacentNavigation";

export type SessionAdjacentNavVariant = "coach" | "manager" | "athlete";

type Props = {
  variant: SessionAdjacentNavVariant;
  sessionId: string;
};

const PATH: Record<SessionAdjacentNavVariant, string> = {
  coach: "/(app)/coach/session/",
  manager: "/(app)/manager/session/",
  athlete: "/(app)/athlete/session/",
};

export function SessionAdjacentNav({ variant, sessionId }: Props) {
  const { t, isRTL, rowFlip } = useI18n();
  const chrome = useBottomChrome();
  const [adj, setAdj] = useState<AdjacentSessionIds | null>(null);

  useEffect(() => {
    const sid = String(sessionId ?? "").trim();
    setAdj(null);
    if (!sid) return;
    let cancelled = false;
    (async () => {
      const next =
        variant === "athlete" ? await getAthleteAdjacentSessionIds(sid) : await getStaffAdjacentSessionIds(sid);
      if (!cancelled) setAdj(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, sessionId]);

  const hasBar = adj !== null && !!(adj.prevId || adj.nextId);
  const onBarLayout = useReportBottomBar(hasBar);

  if (adj === null || (!adj.prevId && !adj.nextId)) return null;

  function go(targetId: string) {
    if (Platform.OS === "ios" || Platform.OS === "android") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.replace(`${PATH[variant]}${targetId}` as Href);
  }

  // The contact footer (athletes) already sits below this bar and owns the safe-area inset.
  const bottomPad = barBottomInset(chrome, theme.spacing.xs);

  return (
    <View
      style={[styles.wrap, { paddingBottom: bottomPad }]}
      onLayout={onBarLayout}
      accessibilityRole="toolbar"
    >
      {/* Follows the UI direction (like the week calendar): in Hebrew "previous" is on the right pointing right. */}
      <View style={[styles.splitRow, rowFlip && styles.splitRowFlip]}>
        <Pressable
          onPress={() => adj.prevId && go(adj.prevId)}
          disabled={!adj.prevId}
          style={({ pressed }) => [
            styles.half,
            Platform.OS === "web" && styles.targetWeb,
            Platform.OS === "web" && !adj.prevId && styles.targetDisabledWeb,
            pressed && !!adj.prevId && styles.halfPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("sessionNav.prevA11y")}
          accessibilityState={{ disabled: !adj.prevId }}
        >
          {/* Arrow on the outer edge, then the label; the row follows the reading direction. */}
          <View style={[styles.halfContent, rowFlip && styles.splitRowFlip]}>
            <Text style={[styles.arrow, !adj.prevId && styles.arrowMuted]} allowFontScaling={false}>
              {isRTL ? "→" : "←"}
            </Text>
            <Text style={[styles.label, !adj.prevId && styles.arrowMuted]} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
              {t("sessionNav.prevA11y")}
            </Text>
          </View>
        </Pressable>
        <View style={styles.divider} pointerEvents="none" />
        <Pressable
          onPress={() => adj.nextId && go(adj.nextId)}
          disabled={!adj.nextId}
          style={({ pressed }) => [
            styles.half,
            Platform.OS === "web" && styles.targetWeb,
            Platform.OS === "web" && !adj.nextId && styles.targetDisabledWeb,
            pressed && !!adj.nextId && styles.halfPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("sessionNav.nextA11y")}
          accessibilityState={{ disabled: !adj.nextId }}
        >
          <View style={[styles.halfContent, rowFlip && styles.splitRowFlip]}>
            <Text style={[styles.label, !adj.nextId && styles.arrowMuted]} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
              {t("sessionNav.nextA11y")}
            </Text>
            <Text style={[styles.arrow, !adj.nextId && styles.arrowMuted]} allowFontScaling={false}>
              {isRTL ? "←" : "→"}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Same chrome as `StudioContactFooter` so it blends with the contact row below. */
  wrap: {
    paddingTop: theme.spacing.xs,
    backgroundColor: theme.colors.backgroundAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  splitRow: {
    width: "100%",
    maxWidth: LAYOUT.maxContentWidth.standard,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 36,
  },
  splitRowFlip: { flexDirection: "row-reverse" },
  /** Full-width halves — large horizontal tap targets; arrows only (no circle). */
  half: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.controls.minTouch,
    paddingHorizontal: theme.spacing.sm,
  },
  halfPressed: {
    backgroundColor: "rgba(244, 244, 245, 0.06)",
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    marginVertical: 6,
    backgroundColor: theme.colors.borderMuted,
    opacity: 0.85,
  },
  targetWeb: {
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as ViewStyle) : {}),
  },
  targetDisabledWeb: {
    ...(Platform.OS === "web" ? ({ cursor: "not-allowed" } as unknown as ViewStyle) : {}),
  },
  arrow: {
    fontSize: 20,
    fontWeight: "600",
    color: theme.colors.cta,
    textAlign: "center",
    writingDirection: "ltr",
    lineHeight: 20,
    ...Platform.select({
      android: {
        includeFontPadding: false,
        textAlignVertical: "center",
      },
      default: {},
    }),
  },
  halfContent: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs, maxWidth: "100%" },
  label: { ...theme.typography.caption, color: theme.colors.textMuted, flexShrink: 1 },
  arrowMuted: {
    color: theme.colors.textSoft,
  },
});
