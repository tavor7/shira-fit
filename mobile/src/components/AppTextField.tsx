import { forwardRef, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  TextInput,
  View,
  Pressable,
  StyleSheet,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { useI18n } from "../context/I18nContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = TextInputProps & {
  label?: string;
  error?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  isRTL?: boolean;
  /** Light paper field (default) or dark chrome field for auth screens. */
  variant?: "paper" | "dark";
  /** Short guidance under the field. */
  helperText?: string;
  /** Validation message under the field; also marks the field invalid. */
  errorText?: string;
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
    helperText,
    errorText,
    onFocus,
    onBlur,
    nativeID,
    ...rest
  },
  ref
) {
  const { t } = useI18n();
  const isDark = variant === "dark";
  const invalid = !!error || !!errorText;
  const [focused, setFocused] = useState(false);
  const messageId = nativeID ? `${nativeID}-message` : undefined;
  const a11yLabel = accessibilityLabel ?? label;
  const [revealed, setRevealed] = useState(false);
  const isPasswordField = !!secureTextEntry;

  // Shake + a brief red flash the moment a field *becomes* invalid — not on every re-render
  // while it stays invalid, which would just be noise while the user keeps typing.
  const shakeX = useRef(new Animated.Value(0)).current;
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const wasErrorRef = useRef(invalid);
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    const justBecameInvalid = invalid && !wasErrorRef.current;
    wasErrorRef.current = invalid;
    if (!justBecameInvalid || reduceMotionRef.current) return;
    if (Platform.OS === "ios" || Platform.OS === "android") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    shakeX.setValue(0);
    flashOpacity.setValue(0.5);
    Animated.sequence([
      Animated.timing(shakeX, { toValue: -10, duration: 55, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 8, duration: 55, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: -6, duration: 55, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 4, duration: 55, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 0, duration: 55, easing: Easing.linear, useNativeDriver: true }),
    ]).start();
    Animated.timing(flashOpacity, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalid]);

  return (
    <View style={containerStyle}>
      {label ? (
        <AppText variant="label" muted style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: shakeX }] }}>
        <TextInput
          ref={ref}
          style={[
            styles.input,
            isDark ? styles.inputDark : styles.inputPaper,
            focused && styles.inputFocused,
            invalid && styles.inputError,
            invalid && focused && styles.inputErrorFocused,
            isRTL && styles.rtl,
            isPasswordField && (isRTL ? styles.inputPadLeft : styles.inputPadRight),
            style,
          ]}
          placeholderTextColor={placeholderTextColor ?? (isDark ? theme.colors.textSoft : theme.colors.placeholderOnLight)}
          accessibilityLabel={a11yLabel}
          secureTextEntry={isPasswordField && !revealed}
          nativeID={nativeID}
          aria-invalid={invalid || undefined}
          aria-describedby={messageId && (errorText || helperText) ? messageId : undefined}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
        <Animated.View pointerEvents="none" style={[styles.errorFlash, { opacity: flashOpacity }]} />
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
      </Animated.View>
      {errorText || helperText ? (
        <AppText
          nativeID={messageId}
          variant="helper"
          color={errorText ? theme.colors.error : theme.colors.textMuted}
          isRTL={isRTL}
          style={styles.message}
          accessibilityLiveRegion={errorText ? "polite" : undefined}
        >
          {errorText || helperText}
        </AppText>
      ) : null}
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
  errorFlash: {
    ...StyleSheet.absoluteFill,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.error,
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
  /** Focus: a brighter, 2px border (padding absorbs the extra pixel so text does not move). */
  inputFocused: {
    borderWidth: 2,
    borderColor: theme.colors.cta,
    paddingVertical: theme.spacing.sm - 1,
    paddingHorizontal: theme.spacing.md - 1,
  },
  inputError: {
    borderColor: theme.colors.error,
  },
  inputErrorFocused: {
    borderColor: theme.colors.error,
  },
  message: {
    marginTop: theme.spacing.xs,
  },
  inputPadRight: { paddingRight: 64 },
  inputPadLeft: { paddingLeft: 64 },
  /**
   * Right-aligned in Hebrew, but the text's own direction comes from its content (inputs keep dir="auto"):
   * forcing RTL on a long English address or email clipped its beginning instead of its end.
   */
  rtl: {
    textAlign: "right",
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
