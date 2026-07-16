import { useEffect, useRef } from "react";
import { Animated, View, Text, Pressable } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { pricingScreenStyles as ps } from "./pricingScreenStyles";

type Props = {
  label: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  isRTL?: boolean;
  accessibilityLabel: string;
};

export function PricingPickerField({ label, value, placeholder, onPress, isRTL, accessibilityLabel }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const prevValueRef = useRef(value);
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    if (!value || reduceMotionRef.current) return;
    scale.setValue(0.96);
    Animated.timing(scale, {
      toValue: 1,
      duration: theme.motion.normal,
      easing: theme.motion.springOvershoot,
      useNativeDriver: true,
    }).start();
  }, [value, scale, reduceMotionRef]);

  return (
    <View>
      <Text style={[ps.label, isRTL && ps.rtl]}>{label}</Text>
      <Pressable
        style={({ pressed }) => [ps.pickerTouch, pressed && { opacity: 0.85 }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Text style={value ? ps.pickerText : ps.pickerPlaceholder} numberOfLines={2}>
            {value || placeholder}
          </Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}
