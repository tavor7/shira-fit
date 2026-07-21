import { useEffect, useRef, type ReactNode } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  /** Set true once the row's removal is confirmed — plays the exit once, on the rising edge. */
  leaving: boolean;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  /** Fires when the exit finishes (or immediately, under reduced motion) — do the actual data removal here. */
  onDone?: () => void;
};

/** Slides a row out to the side + fades it, instead of it just disappearing when removed from a list. */
export function FlyOffRow({ leaving, isRTL, style, children, onDone }: Props) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();
  const firedRef = useRef(false);

  useEffect(() => {
    if (leaving && !firedRef.current) {
      firedRef.current = true;
      if (reduceMotionRef.current) {
        onDone?.();
        return;
      }
      Animated.timing(progress, {
        toValue: 1,
        duration: 380,
        easing: theme.motion.easeOut,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onDone?.();
      });
    } else if (!leaving) {
      firedRef.current = false;
      progress.setValue(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const dir = isRTL ? -1 : 1;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 140 * dir] });
  const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${6 * dir}deg`] });

  return (
    <Animated.View style={[style, { transform: [{ translateX }, { rotate }], opacity }]}>
      {children}
    </Animated.View>
  );
}
