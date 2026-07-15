import { useEffect, useRef } from "react";
import {
  Pressable,
  Text,
  View,
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  ViewStyle,
  TextStyle,
  Platform,
} from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

function primaryTapFeedback() {
  if (Platform.OS === "ios" || Platform.OS === "android") {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

function dangerTapFeedback() {
  if (Platform.OS === "ios" || Platform.OS === "android") {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }
}

function successFeedback() {
  if (Platform.OS === "ios" || Platform.OS === "android") {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }
}

type Props = {
  label: string;
  loadingLabel?: string;
  loading?: boolean;
  /** Momentary success state — swaps the label for a checkmark that pops in, with a success haptic. */
  success?: boolean;
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
  /** `cta` = light filled (main). `ghost` = dark filled subtle border. `danger` = destructive action. */
  variant?: "cta" | "ghost" | "danger";
};

export function PrimaryButton({
  label,
  loadingLabel = "Loading…",
  loading,
  success,
  onPress,
  disabled,
  style,
  variant = "cta",
}: Props) {
  const busy = loading || disabled || success;
  const isCta = variant === "cta";
  const isDanger = variant === "danger";
  const textStyle = isCta ? styles.textCta : isDanger ? styles.textDanger : styles.textGhost;
  const successScale = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (!success) {
      successScale.setValue(0);
      return;
    }
    successFeedback();
    Animated.timing(successScale, {
      toValue: 1,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal,
      easing: Easing.out(Easing.back(1.4)),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.btn,
        isCta ? styles.btnCta : isDanger ? styles.btnDanger : styles.btnGhost,
        (loading || disabled) && styles.disabled,
        pressed && !busy && (isCta ? styles.pressedCta : styles.pressedGhost),
        style,
      ]}
      onPress={() => {
        if (busy) return;
        if (isDanger) dangerTapFeedback();
        else primaryTapFeedback();
        onPress();
      }}
      disabled={busy}
      android_ripple={{
        color: isCta ? "rgba(10,10,11,0.12)" : "rgba(244,244,245,0.08)",
      }}
    >
      {success ? (
        <Animated.View style={{ transform: [{ scale: successScale }] }}>
          <Text style={styles.successIcon}>{"✓"}</Text>
        </Animated.View>
      ) : loading ? (
        <View style={styles.row}>
          <ActivityIndicator color={isCta ? theme.colors.ctaText : theme.colors.text} style={{ marginRight: 10 }} />
          <Text style={[styles.text, textStyle]}>{loadingLabel}</Text>
        </View>
      ) : (
        <Text style={[styles.text, textStyle]} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: theme.radius.md,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  btnCta: {
    backgroundColor: theme.colors.cta,
  },
  btnGhost: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnDanger: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
  },
  disabled: { opacity: 0.5 },
  pressedCta: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  pressedGhost: { opacity: 0.88 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  text: { fontWeight: "600", fontSize: 16, letterSpacing: 0.2 } as TextStyle,
  textCta: { color: theme.colors.ctaText },
  textGhost: { color: theme.colors.text },
  textDanger: { color: theme.colors.error },
  successIcon: { fontSize: 22, fontWeight: "900", color: theme.colors.success },
});
