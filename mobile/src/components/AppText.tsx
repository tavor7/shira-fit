import { Text, StyleSheet, type TextProps, type TextStyle, type StyleProp } from "react-native";
import { theme, type TypographyVariant } from "../theme";

type Props = TextProps & {
  variant?: TypographyVariant;
  muted?: boolean;
  soft?: boolean;
  color?: string;
  style?: StyleProp<TextStyle>;
  isRTL?: boolean;
};

export function AppText({
  variant = "body",
  muted,
  soft,
  color,
  style,
  isRTL,
  maxFontSizeMultiplier = theme.a11y.bodyMaxFontMultiplier,
  ...rest
}: Props) {
  const variantStyle = theme.typography[variant];
  const textColor =
    color ?? (soft ? theme.colors.textSoft : muted ? theme.colors.textMuted : theme.colors.text);

  return (
    <Text
      style={[
        styles.base,
        variantStyle,
        { color: textColor },
        isRTL && styles.rtl,
        style,
      ]}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    color: theme.colors.text,
  },
  rtl: {
    textAlign: "right",
    writingDirection: "rtl",
  },
});
