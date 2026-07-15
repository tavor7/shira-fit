import { forwardRef, useState } from "react";
import {
  TextInput,
  View,
  Pressable,
  StyleSheet,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { useI18n } from "../context/I18nContext";

type Props = TextInputProps & {
  label?: string;
  error?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  isRTL?: boolean;
  /** Light paper field (default) or dark chrome field for auth screens. */
  variant?: "paper" | "dark";
};

export const AppTextField = forwardRef<TextInput, Props>(function AppTextField(
  {
    label,
    error,
    containerStyle,
    isRTL,
    variant = "paper",
    style,
    placeholderTextColor,
    accessibilityLabel,
    secureTextEntry,
    ...rest
  },
  ref
) {
  const { t } = useI18n();
  const isDark = variant === "dark";
  const a11yLabel = accessibilityLabel ?? label;
  const [revealed, setRevealed] = useState(false);
  const isPasswordField = !!secureTextEntry;

  return (
    <View style={containerStyle}>
      {label ? (
        <AppText variant="label" muted style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <View>
        <TextInput
          ref={ref}
          style={[
            styles.input,
            isDark ? styles.inputDark : styles.inputPaper,
            error && styles.inputError,
            isRTL && styles.rtl,
            isPasswordField && (isRTL ? styles.inputPadLeft : styles.inputPadRight),
            style,
          ]}
          placeholderTextColor={placeholderTextColor ?? (isDark ? theme.colors.textSoft : theme.colors.placeholderOnLight)}
          accessibilityLabel={a11yLabel}
          secureTextEntry={isPasswordField && !revealed}
          {...rest}
        />
        {isPasswordField ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            style={({ pressed }) => [
              styles.toggle,
              isRTL ? styles.toggleLeft : styles.toggleRight,
              pressed && styles.togglePressed,
            ]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={revealed ? t("auth.hidePassword") : t("auth.showPassword")}
          >
            <AppText variant="caption" muted style={styles.toggleTxt}>
              {revealed ? t("common.hide") : t("common.show")}
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

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
  inputPadRight: { paddingRight: 64 },
  inputPadLeft: { paddingLeft: 64 },
  rtl: {
    textAlign: "right",
    writingDirection: "rtl",
  },
  toggle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.sm,
  },
  toggleRight: { right: 0 },
  toggleLeft: { left: 0 },
  togglePressed: { opacity: 0.6 },
  toggleTxt: { fontWeight: "700" },
});
