import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Delay in ms before the animation starts (for a subtle stagger between blocks). */
  delay?: number;
};

/** One-shot fade + rise on mount — used for auth-screen content so first paint feels intentional. */
export function FadeSlideIn({ children, style, delay = 0 }: Props) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      delay: reduceMotionRef.current ? 0 : delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
