import { useCallback, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Track/slot tab switcher with a single solid pill that slides + resizes to the selected
 * tab instead of each slot independently swapping its own background. Single source for the
 * pattern previously duplicated inline in ManagerReportsScreen and PricingHubScreen.
 */
export function SlidingPillTabBar({ tabs, active, onChange, style }: Props) {
  const { language, isRTL } = useI18n();
  const layouts = useRef<Record<string, { x: number; width: number }>>({});
  const indicatorX = useRef(new Animated.Value(0)).current;
  const indicatorW = useRef(new Animated.Value(0)).current;
  const indicatorOpacity = useRef(new Animated.Value(0)).current;
  const [measured, setMeasured] = useState(false);
  const reduceMotionRef = useReduceMotionRef();

  const moveTo = useCallback(
    (id: string, animate: boolean) => {
      const l = layouts.current[id];
      if (!l) return;
      if (animate && !reduceMotionRef.current) {
        Animated.parallel([
          Animated.timing(indicatorX, {
            toValue: l.x,
            duration: theme.motion.normal,
            easing: theme.motion.easeOut,
            useNativeDriver: false,
          }),
          Animated.timing(indicatorW, {
            toValue: l.width,
            duration: theme.motion.normal,
            easing: theme.motion.easeOut,
            useNativeDriver: false,
          }),
        ]).start();
      } else {
        indicatorX.setValue(l.x);
        indicatorW.setValue(l.width);
      }
    },
    [indicatorX, indicatorW, reduceMotionRef]
  );

  const handleLayout = (id: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    const prev = layouts.current[id];
    layouts.current[id] = { x, width };
    if (id === active && (!prev || prev.x !== x || prev.width !== width)) {
      moveTo(id, false);
      if (!measured) {
        setMeasured(true);
        Animated.timing(indicatorOpacity, {
          toValue: 1,
          duration: theme.motion.fast,
          easing: theme.motion.easeOut,
          useNativeDriver: false,
        }).start();
      }
    }
  };

  return (
    <View style={[styles.track, isRTL && styles.trackRtl, style]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.indicator,
          { transform: [{ translateX: indicatorX }], width: indicatorW, opacity: indicatorOpacity },
        ]}
      />
      {tabs.map((x) => {
        const on = x.id === active;
        return (
          <Pressable
            key={x.id}
            onLayout={handleLayout(x.id)}
            onPress={() => {
              onChange(x.id);
              moveTo(x.id, true);
            }}
            style={({ pressed }) => [styles.slot, pressed && !on && styles.slotPressed]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={language === "he" ? `מעבר ל-${x.label}` : `Go to ${x.label}`}
          >
            <Text style={[styles.slotTxt, on && styles.slotTxtOn]} numberOfLines={1}>
              {x.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  trackRtl: { flexDirection: "row-reverse" },
  indicator: {
    position: "absolute",
    top: theme.spacing.xs,
    bottom: theme.spacing.xs,
    left: 0,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  slot: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 120,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  slotPressed: { opacity: 0.85 },
  slotTxt: {
    fontWeight: "800",
    fontSize: 12,
    color: theme.colors.textMuted,
    letterSpacing: 0.15,
    lineHeight: 16,
  },
  slotTxtOn: { color: theme.colors.ctaText },
});
