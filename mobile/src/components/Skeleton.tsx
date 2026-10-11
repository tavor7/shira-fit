import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotion } from "../hooks/useReduceMotion";
import { useIsOffline, useRegisterLoadingPlaceholder } from "../lib/networkStatus";

type Props = {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
};

/**
 * Pulsing placeholder block for content that's still loading. While the device is offline it stops
 * pulsing and dims (no fake progress); the connection bar explains why (Phase 5 / O).
 */
export function Skeleton({ width = "100%", height = 14, radius = theme.radius.sm, style }: Props) {
  useRegisterLoadingPlaceholder();
  const offline = useIsOffline();
  const reduceMotion = useReduceMotion() || offline;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(offline ? 0 : 0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: theme.motion.normal,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: theme.motion.normal,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion, offline]);

  const opacity = offline ? 0.25 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.85] });

  return (
    <Animated.View
      style={[
        styles.base,
        { width: width as ViewStyle["width"], height, borderRadius: radius, opacity },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: theme.colors.surfaceElevated,
  },
});
