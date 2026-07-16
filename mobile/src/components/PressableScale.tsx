import { forwardRef, useRef } from "react";
import {
  Animated,
  Pressable,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = Omit<PressableProps, "style" | "children"> & {
  /** Same function-as-prop signature as Pressable's `style` — use it for non-transform styling (background, border, opacity). */
  style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
  children?: React.ReactNode | ((state: PressableStateCallbackType) => React.ReactNode);
  /** Scale applied on press-in, eased back to 1 on press-out/cancel. */
  scaleTo?: number;
};

/** Pressable wrapper adding an animated scale+opacity press feedback, respecting reduce-motion. */
export const PressableScale = forwardRef<View, Props>(function PressableScale(
  { style, children, scaleTo = 0.97, onPressIn, onPressOut, ...rest },
  ref
) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduceMotionRef = useReduceMotionRef();

  const animateTo = (toValue: number) => {
    Animated.timing(scale, {
      toValue: reduceMotionRef.current ? 1 : toValue,
      duration: theme.motion.fast,
      easing: theme.motion.easeOut,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      ref={ref}
      style={style}
      onPressIn={(e: GestureResponderEvent) => {
        animateTo(scaleTo);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        animateTo(1);
        onPressOut?.(e);
      }}
      {...rest}
    >
      {(state) => (
        <Animated.View style={{ transform: [{ scale }] }}>
          {typeof children === "function" ? children(state) : children}
        </Animated.View>
      )}
    </Pressable>
  );
});
