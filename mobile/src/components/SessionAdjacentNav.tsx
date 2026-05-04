import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, Platform, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
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

  if (adj === null || (!adj.prevId && !adj.nextId)) return null;

  function go(targetId: string) {
    if (Platform.OS === "ios" || Platform.OS === "android") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.replace(`${PATH[variant]}${targetId}` as Href);
  }

  const bottomPad = Math.max(insets.bottom, theme.spacing.xs);

  return (
    <View
      style={[styles.wrap, { paddingBottom: bottomPad }]}
      accessibilityRole="toolbar"
    >
      <View style={styles.splitRow}>
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
          <Text style={[styles.arrow, !adj.prevId && styles.arrowMuted]} allowFontScaling={false}>
            ←
          </Text>
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
          <Text style={[styles.arrow, !adj.nextId && styles.arrowMuted]} allowFontScaling={false}>
            →
          </Text>
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
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 36,
    writingDirection: "ltr",
  },
  /** Full-width halves — large horizontal tap targets; arrows only (no circle). */
  half: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
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
  arrowMuted: {
    color: theme.colors.textSoft,
  },
});
