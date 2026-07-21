import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  visible: boolean;
  style?: StyleProp<TextStyle>;
};

/** A checkmark glyph that pops in with a small overshoot instead of just appearing — for consent checkboxes. */
export function AnimatedCheckMark({ visible, style }: Props) {
  const scale = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    Animated.timing(scale, {
      toValue: visible ? 1 : 0,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      easing: visible ? Easing.out(Easing.back(1.4)) : theme.motion.easeIn,
      useNativeDriver: true,
    }).start();
  }, [visible, scale, reduceMotionRef]);

  return (
    <Animated.Text style={[styles.mark, style, { transform: [{ scale }] }]}>{"✓"}</Animated.Text>
  );
}

const styles = StyleSheet.create({
  mark: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
});
