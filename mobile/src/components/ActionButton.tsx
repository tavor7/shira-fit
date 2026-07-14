import { Platform, Pressable, StyleSheet, Text, ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";

function actionTapFeedback(isDanger: boolean) {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  if (isDanger) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
  /** `default` = neutral bordered pill. `danger` = destructive action. */
  variant?: "default" | "danger";
};

export function ActionButton({ label, onPress, disabled, style, variant = "default" }: Props) {
  const isDanger = variant === "danger";
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        actionTapFeedback(isDanger);
        onPress();
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        isDanger && styles.btnDanger,
        disabled && { opacity: 0.5 },
        pressed && !disabled && (isDanger ? styles.pressedDanger : styles.pressed),
        style,
      ]}
      accessibilityRole="button"
    >
      <Text style={[styles.txt, isDanger && styles.txtDanger]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: theme.radius.md,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  btnDanger: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  pressed: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.borderInput,
  },
  pressedDanger: {
    opacity: 0.88,
  },
  txt: {
    color: theme.colors.text,
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.15,
    textAlign: "center",
  },
  txtDanger: {
    color: theme.colors.error,
  },
});
