import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { resolveTrainerAccentColor } from "../lib/trainerCalendarColor";
import type { PresentStaffMember } from "../hooks/useSessionPresence";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function PresenceAvatar({ member, index }: { member: PresentStaffMember; index: number }) {
  const scale = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    Animated.timing(scale, {
      toValue: 1,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      delay: reduceMotionRef.current ? 0 : index * 90,
      easing: theme.motion.springOvershoot,
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[
        styles.avatar,
        {
          backgroundColor: resolveTrainerAccentColor(null, member.userId),
          marginStart: index === 0 ? 0 : -8,
          transform: [{ scale }],
          zIndex: 10 - index,
        },
      ]}
    >
      <Text style={styles.avatarTxt}>{initials(member.name)}</Text>
    </Animated.View>
  );
}

/** Shows which other staff currently have this same session open — Realtime Presence, no polling. */
export function SessionPresenceBar({ others }: { others: PresentStaffMember[] }) {
  const { t, isRTL } = useI18n();
  if (others.length === 0) return null;

  const label =
    others.length === 1
      ? t("sessionPresence.oneViewing").replace("{name}", others[0]!.name)
      : t("sessionPresence.manyViewing").replace("{n}", String(others.length));

  return (
    <View style={[styles.row, isRTL && styles.rowRtl]}>
      <View style={[styles.stack, isRTL && styles.stackRtl]}>
        {others.slice(0, 4).map((m, i) => (
          <PresenceAvatar key={m.userId} member={m} index={i} />
        ))}
      </View>
      <Text style={[styles.label, isRTL && styles.rtlText]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  rowRtl: { flexDirection: "row-reverse" },
  stack: { flexDirection: "row", alignItems: "center" },
  stackRtl: { flexDirection: "row-reverse" },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.colors.backgroundAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: { fontSize: 9, fontWeight: "800", color: "#fff" },
  label: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, flexShrink: 1 },
  rtlText: { textAlign: "right" },
});
