import { Pressable, StyleSheet, Text, ViewStyle } from "react-native";
import { theme } from "../theme";

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
};

export function ActionButton({ label, onPress, disabled, style }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        disabled && { opacity: 0.5 },
        pressed && !disabled && styles.pressed,
        style,
      ]}
      accessibilityRole="button"
    >
      <Text style={styles.txt}>{label}</Text>
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
  pressed: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.borderInput,
  },
  txt: {
    color: theme.colors.text,
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.15,
    textAlign: "center",
  },
});
