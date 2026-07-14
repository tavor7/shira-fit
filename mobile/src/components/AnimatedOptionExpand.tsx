import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useReduceMotion } from "../hooks/useReduceMotion";

type Props = {
  open: boolean;
  children: ReactNode;
};

const EASE = Easing.out(Easing.cubic);

export function AnimatedOptionExpand({ open, children }: Props) {
  const [measuredH, setMeasuredH] = useState(0);
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    const duration = reduceMotion ? 0 : theme.motion.normal;
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration,
      easing: EASE,
      useNativeDriver: false,
    }).start();
  }, [open, progress, reduceMotion]);

  const height =
    measuredH > 0
      ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, measuredH] })
      : 0;
  const opacity = progress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0.6, 1] });
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] });
  const marginTop = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 6] });

  return (
    <Animated.View style={[styles.shell, { height, opacity, marginTop }]}>
      <Animated.View style={{ transform: [{ translateY }] }}>
        <View
          onLayout={(e) => {
            const h = Math.ceil(e.nativeEvent.layout.height);
            if (h > 0 && h !== measuredH) setMeasuredH(h);
          }}
          style={styles.measure}
          pointerEvents={open ? "auto" : "none"}
        >
          {children}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shell: { overflow: "hidden" },
  measure: { width: "100%" },
});
