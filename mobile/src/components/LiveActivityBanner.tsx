import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import type { LiveActivityBannerItem } from "../hooks/useLiveActivityBanner";

const HOLD_MS = 2600;

/** Slams down from the top of the screen for a live registration/cancellation, then retreats. */
export function LiveActivityBanner({
  item,
  onDismiss,
}: {
  item: LiveActivityBannerItem | null;
  onDismiss: () => void;
}) {
  const translateY = useRef(new Animated.Value(-140)).current;
  const dotScale = useRef(new Animated.Value(1)).current;
  const reduceMotionRef = useReduceMotionRef();
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dotLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!item) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);

    const dismiss = () => {
      dotLoop.current?.stop();
      Animated.timing(translateY, {
        toValue: -140,
        duration: reduceMotionRef.current ? 0 : 340,
        easing: theme.motion.easeIn,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onDismiss();
      });
    };

    Animated.timing(translateY, {
      toValue: 0,
      duration: reduceMotionRef.current ? 0 : 560,
      easing: theme.motion.springOvershoot,
      useNativeDriver: true,
    }).start();

    if (!reduceMotionRef.current) {
      dotLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(dotScale, { toValue: 1.7, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(dotScale, { toValue: 1, duration: 350, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        ])
      );
      dotLoop.current.start();
    }

    holdTimer.current = setTimeout(dismiss, HOLD_MS);
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      dotLoop.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  if (!item) return null;

  const bg = item.tone === "success" ? theme.colors.success : theme.colors.error;
  const fg = item.tone === "success" ? "#06170b" : "#2a0a0a";

  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, { transform: [{ translateY }] }]}>
      <Pressable
        onPress={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          dotLoop.current?.stop();
          Animated.timing(translateY, {
            toValue: -140,
            duration: 220,
            easing: theme.motion.easeIn,
            useNativeDriver: true,
          }).start(({ finished }) => {
            if (finished) onDismiss();
          });
        }}
        style={[styles.banner, { backgroundColor: bg }]}
        accessibilityRole="button"
      >
        <Animated.View style={[styles.dot, { backgroundColor: fg, transform: [{ scale: dotScale }] }]} />
        <Text style={[styles.txt, { color: fg }]} numberOfLines={2}>
          {item.message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 10,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  txt: { flex: 1, fontSize: 13.5, fontWeight: "800" },
});
