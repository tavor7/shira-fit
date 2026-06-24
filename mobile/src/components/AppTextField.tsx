import { TextInput, View, StyleSheet, type TextInputProps, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";

type Props = TextInputProps & {
  label?: string;
  error?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  isRTL?: boolean;
  /** Light paper field (default) or dark chrome field for auth screens. */
  variant?: "paper" | "dark";
};

export function AppTextField({
  label,
  error,
  containerStyle,
  isRTL,
  variant = "paper",
  style,
  placeholderTextColor,
  accessibilityLabel,
  ...rest
}: Props) {
  const isDark = variant === "dark";
  const a11yLabel = accessibilityLabel ?? label;

  return (
    <View style={containerStyle}>
      {label ? (
        <AppText variant="label" muted style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <TextInput
        style={[
          styles.input,
          isDark ? styles.inputDark : styles.inputPaper,
          error && styles.inputError,
          isRTL && styles.rtl,
          style,
        ]}
        placeholderTextColor={placeholderTextColor ?? (isDark ? theme.colors.textSoft : theme.colors.placeholderOnLight)}
        accessibilityLabel={a11yLabel}
        {...rest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    marginBottom: theme.spacing.xs,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.typography.body.lineHeight,
    fontWeight: theme.typography.body.fontWeight,
    minHeight: 48,
  },
  inputPaper: {
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  inputDark: {
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  inputError: {
    borderColor: theme.colors.error,
  },
  rtl: {
    textAlign: "right",
    writingDirection: "rtl",
  },
});
