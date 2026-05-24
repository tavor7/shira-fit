import { Pressable, Text, StyleSheet } from "react-native";
import { theme } from "../theme";

type Props = {
  label: string;
  onPress: () => void;
  isRTL?: boolean;
  disabled?: boolean;
};

export function PricingSectionAddButton({ label, onPress, isRTL, disabled }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        isRTL && styles.btnRtl,
        disabled && styles.btnDisabled,
        pressed && !disabled && { opacity: 0.9 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.plus, disabled && styles.txtDisabled]}>+</Text>
      <Text style={[styles.label, isRTL && styles.rtl, disabled && styles.txtDisabled]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    borderWidth: 1,
    borderColor: theme.colors.cta,
  },
  btnRtl: { flexDirection: "row-reverse" },
  btnDisabled: { opacity: 0.45 },
  plus: { fontSize: 18, fontWeight: "800", color: theme.colors.ctaText, lineHeight: 20 },
  label: { fontSize: 14, fontWeight: "800", color: theme.colors.ctaText, flexShrink: 1 },
  txtDisabled: { color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
