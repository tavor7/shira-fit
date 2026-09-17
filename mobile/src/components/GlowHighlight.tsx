import { useEffect, useRef, type ReactNode } from "react";
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  /** Runs the glow loop while true; stops (and fades out) once flipped to false. */
  active: boolean;
  /** How many pulse cycles before it settles on its own (ignored if `active` flips false first). */
  cycles?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** Looping border/shadow pulse to draw the eye to a specific control — settles after a few cycles. */
export function GlowHighlight({ active, cycles = 4, style, children }: Props) {
  const glow = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    loopRef.current?.stop();
    if (!active) {
      Animated.timing(glow, { toValue: 0, duration: theme.motion.normal, useNativeDriver: false }).start();
      return;
    }
    if (reduceMotionRef.current) {
      glow.setValue(1);
      return;
    }
    const pulse = Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 550, useNativeDriver: false }),
      Animated.timing(glow, { toValue: 0.25, duration: 550, useNativeDriver: false }),
    ]);
    const loop = Animated.loop(pulse, { iterations: cycles });
    loopRef.current = loop;
    loop.start(({ finished }) => {
      if (finished) Animated.timing(glow, { toValue: 0, duration: theme.motion.normal, useNativeDriver: false }).start();
    });
    return () => loop.stop();
  }, [active, cycles, glow, reduceMotionRef]);

  const borderColor = glow.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.colors.borderMuted, theme.colors.cta],
  });
  const shadowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] });

  return (
    <Animated.View
      style={[
        style,
        styles.glowBase,
        {
          borderColor,
          shadowColor: theme.colors.cta,
          shadowOpacity,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 0 },
          elevation: 6,
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glowBase: { borderWidth: 2 },
});
