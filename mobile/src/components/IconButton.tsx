import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppIcon, type AppIconName } from "./AppIcon";

type Props = {
  icon: AppIconName;
  /** Required: icon-only controls must be named for assistive technology. */
  accessibilityLabel: string;
  onPress: () => void;
  /** Visible diameter. The touch area is extended to at least theme.controls.minTouch. */
  size?: number;
  /** `surface` = bordered circle; `plain` = icon only; `danger` = destructive tint. */
  variant?: "surface" | "plain" | "danger";
  iconSize?: "sm" | "md" | "lg";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Compact icon-only control with a full-size hit area. The touch target is an invisible ring of padding
 * offset by an equal negative margin, so it reaches theme.controls.minTouch without moving the layout;
 * this works on the web too (react-native-web ignores hitSlop).
 */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 32,
  variant = "surface",
  iconSize = "sm",
  disabled,
  style,
}: Props) {
  const slop = Math.max(0, Math.ceil((theme.controls.minTouch - size) / 2));
  const color = variant === "danger" ? theme.colors.error : theme.colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={[{ padding: slop, margin: -slop }, style]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.base,
            { width: size, height: size },
            variant === "surface" && styles.surface,
            variant === "danger" && styles.danger,
            pressed && !disabled && styles.pressed,
            disabled && styles.disabled,
          ]}
        >
          <AppIcon name={icon} size={iconSize} color={color} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  surface: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  danger: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
});
