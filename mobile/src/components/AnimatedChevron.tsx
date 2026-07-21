import { useEffect, useRef } from "react";
import { Animated, type StyleProp, type TextStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  open: boolean;
  style?: StyleProp<TextStyle>;
  /** Glyph to rotate. Defaults to a right-pointing caret that turns downward when open. */
  glyph?: string;
};

/** A chevron/caret that eases into its open rotation instead of swapping glyphs instantly. */
export function AnimatedChevron({ open, style, glyph = "▸" }: Props) {
  const rotation = useRef(new Animated.Value(open ? 1 : 0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    Animated.timing(rotation, {
      toValue: open ? 1 : 0,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      easing: theme.motion.easeOut,
      useNativeDriver: true,
    }).start();
  }, [open, rotation, reduceMotionRef]);

  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] });

  return <Animated.Text style={[style, { transform: [{ rotate }] }]}>{glyph}</Animated.Text>;
}
