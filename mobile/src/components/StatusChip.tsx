import { useEffect, useRef } from "react";
import { Animated, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "info";

const toneBg: Record<ChipTone, string> = {
  neutral: "rgba(148,163,184,0.14)",
  success: "rgba(34,197,94,0.14)",
  warning: "rgba(245,158,11,0.14)",
  danger: "rgba(239,68,68,0.14)",
  info: "rgba(96,165,250,0.14)",
};
const toneBorder: Record<ChipTone, string> = {
  neutral: "rgba(148,163,184,0.35)",
  success: "rgba(34,197,94,0.4)",
  warning: "rgba(245,158,11,0.4)",
  danger: "rgba(239,68,68,0.4)",
  info: "rgba(96,165,250,0.4)",
};
const toneTxt: Record<ChipTone, string> = {
  neutral: theme.colors.textMuted,
  success: theme.colors.success,
  warning: theme.colors.warning,
  danger: theme.colors.error,
  info: theme.colors.info,
};

export function StatusChip({ label, tone = "neutral" }: { label: string; tone?: ChipTone }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const prevToneRef = useRef(tone);
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (prevToneRef.current === tone) return;
    prevToneRef.current = tone;
    if (reduceMotionRef.current) return;
    opacity.setValue(0.4);
    Animated.timing(opacity, {
      toValue: 1,
      duration: theme.motion.fast,
      easing: theme.motion.easeOut,
      useNativeDriver: true,
    }).start();
  }, [tone, opacity, reduceMotionRef]);

  return (
    <Animated.View
      style={[styles.wrap, { backgroundColor: toneBg[tone], borderColor: toneBorder[tone], opacity }]}
    >
      <Text style={[styles.txt, { color: toneTxt[tone] }]} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  txt: { fontSize: 10, fontWeight: "800", letterSpacing: 0.35, textTransform: "uppercase" },
});
