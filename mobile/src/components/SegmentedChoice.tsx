import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { selectionA11y } from "../lib/a11ySelection";
import { rowFlipFor } from "../lib/layoutDirection";

export type SegmentedOption<V extends string> = { value: V; label: string };

type Props<V extends string> = {
  options: SegmentedOption<V>[];
  /** The selected value; any value not among the options selects nothing (and is left as it is). */
  value: string | null | undefined;
  onChange: (value: V) => void;
  isRTL: boolean;
  /** Names the group for assistive technology (usually the field label). */
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Single choice among a few short options (equal-width segments, one selected). */
export function SegmentedChoice<V extends string>({ options, value, onChange, isRTL, accessibilityLabel, disabled, style }: Props<V>) {
  return (
    <View
      style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl, style]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            disabled={disabled}
            style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && !on && styles.pressed, disabled && styles.disabled]}
            {...selectionA11y("radio", on, disabled)}
            accessibilityLabel={o.label}
          >
            <AppText variant="tab" style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: theme.spacing.xs },
  rowRtl: { flexDirection: "row-reverse" },
  option: {
    flex: 1,
    minHeight: theme.controls.minTouch,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  optionOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  label: { color: theme.colors.textMuted, textAlign: "center" },
  labelOn: { color: theme.colors.ctaText },
});
