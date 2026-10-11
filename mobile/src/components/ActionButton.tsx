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
      accessibilityState={disabled ? { disabled: true } : undefined}
    >
      <Text style={[styles.txt, isDanger && styles.txtDanger]} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** Compact secondary button: same surface, border and radius as PrimaryButton's ghost variant. */
  btn: {
    minHeight: theme.controls.buttonCompactHeight,
    paddingVertical: 11,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDanger: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  pressed: {
    opacity: 0.88,
    borderColor: theme.colors.borderInput,
  },
  pressedDanger: {
    opacity: 0.88,
  },
  txt: {
    ...theme.typography.buttonCompact,
    color: theme.colors.text,
    textAlign: "center",
  },
  txtDanger: {
    color: theme.colors.error,
  },
});
