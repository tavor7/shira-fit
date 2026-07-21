import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Track color when on. Defaults to the app's crisp CTA color. */
  onColor?: string;
  /** Track color when off. */
  offColor?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const TRACK_W = 46;
const TRACK_H = 27;
const KNOB = 23;
const PAD = 2;

/** Themed switch — one track+sliding-knob shape everywhere, replacing the OS-styled native Switch. */
export function AppSwitch({
  value,
  onValueChange,
  onColor = theme.colors.cta,
  offColor = theme.colors.border,
  disabled,
  accessibilityLabel,
  style,
}: Props) {
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      easing: theme.motion.easeOut,
      useNativeDriver: false,
    }).start();
  }, [value, progress, reduceMotionRef]);

  const trackColor = progress.interpolate({ inputRange: [0, 1], outputRange: [offColor, onColor] });
  const knobX = progress.interpolate({ inputRange: [0, 1], outputRange: [PAD, TRACK_W - KNOB - PAD] });

  return (
    <Pressable
      onPress={() => !disabled && onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={[disabled && styles.disabled, style]}
    >
      <Animated.View style={[styles.track, { backgroundColor: trackColor }]}>
        <Animated.View style={[styles.knob, { transform: [{ translateX: knobX }] }]} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.5 },
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: theme.radius.full,
    justifyContent: "center",
  },
  knob: {
    position: "absolute",
    left: 0,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: theme.colors.text,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
});
