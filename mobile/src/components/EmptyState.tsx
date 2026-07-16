import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { PrimaryButton } from "./PrimaryButton";
import { FadeSlideIn } from "./FadeSlideIn";
import { useReduceMotion } from "../hooks/useReduceMotion";

type Props = {
  title: string;
  body?: string;
  /** Optional emoji or short symbol shown above the title. */
  icon?: string;
  actionLabel?: string;
  onAction?: () => void;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function EmptyState({ title, body, icon, actionLabel, onAction, isRTL, style }: Props) {
  return (
    <FadeSlideIn style={[styles.wrap, style]} accessibilityRole="text">
      {icon ? <FloatingIcon icon={icon} /> : null}
      <AppText variant="title" isRTL={isRTL} style={styles.title}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {actionLabel && onAction ? (
        <PrimaryButton label={actionLabel} onPress={onAction} variant="ghost" style={styles.action} />
      ) : null}
    </FadeSlideIn>
  );
}

/** Slow ambient float on the icon only, so it reads as alive without distracting from the message. */
function FloatingIcon({ icon }: { icon: string }) {
  const reduceMotion = useReduceMotion();
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [float, reduceMotion]);

  const translateY = float.interpolate({ inputRange: [0, 1], outputRange: [-4, 4] });

  return (
    <Animated.View style={{ transform: [{ translateY: reduceMotion ? 0 : translateY }] }}>
      <AppText variant="display" style={styles.icon} accessibilityElementsHidden>
        {icon}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  icon: {
    fontSize: 32,
    lineHeight: 40,
    marginBottom: theme.spacing.xs,
    textAlign: "center",
  },
  title: {
    textAlign: "center",
  },
  body: {
    textAlign: "center",
    maxWidth: 320,
  },
  action: {
    marginTop: theme.spacing.sm,
    alignSelf: "stretch",
    maxWidth: 280,
  },
});
