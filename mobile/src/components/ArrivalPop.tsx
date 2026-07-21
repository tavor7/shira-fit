import { useEffect, useRef, type ReactNode } from "react";
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  /** Fires the swell-and-settle animation each time this flips from false to true. */
  trigger: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** A brief "arriving" swell + success wash — the arrival counterpart to DeflatingCard's departure. */
export function ArrivalPop({ trigger, style, children }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const washOpacity = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();
  const wasTriggeredRef = useRef(false);

  useEffect(() => {
    if (trigger && !wasTriggeredRef.current) {
      wasTriggeredRef.current = true;
      if (!reduceMotionRef.current) {
        washOpacity.setValue(0.5);
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.035,
            duration: 180,
            easing: theme.motion.easeOut,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 320,
            easing: theme.motion.easeOut,
            useNativeDriver: true,
          }),
        ]).start();
        Animated.timing(washOpacity, {
          toValue: 0,
          duration: 550,
          easing: theme.motion.easeOut,
          useNativeDriver: true,
        }).start();
      }
    } else if (!trigger) {
      wasTriggeredRef.current = false;
    }
  }, [trigger, reduceMotionRef, scale, washOpacity]);

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: "rgba(34,197,94,0.28)", borderRadius: theme.radius.md, opacity: washOpacity },
        ]}
      />
    </Animated.View>
  );
}
