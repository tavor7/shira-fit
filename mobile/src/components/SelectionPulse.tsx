import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  /** Fires a quick confirming pulse each time this flips from false to true (e.g. a chip becoming selected). */
  trigger: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** Small scale pulse for confirming a tap-to-select action (filter chips, tier picks) — no layout shift. */
export function SelectionPulse({ trigger, style, children }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduceMotionRef = useReduceMotionRef();
  const wasTriggeredRef = useRef(false);

  useEffect(() => {
    if (trigger && !wasTriggeredRef.current) {
      wasTriggeredRef.current = true;
      if (!reduceMotionRef.current) {
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.1,
            duration: 110,
            easing: theme.motion.easeOut,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 150,
            easing: Easing.out(Easing.back(1.4)),
            useNativeDriver: true,
          }),
        ]).start();
      }
    } else if (!trigger) {
      wasTriggeredRef.current = false;
    }
  }, [trigger, reduceMotionRef, scale]);

  return <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>;
}
