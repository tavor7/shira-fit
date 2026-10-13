import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { AppText } from "../AppText";
import { selectionA11y } from "../../lib/a11ySelection";
import { rowFlipFor } from "../../lib/layoutDirection";

export type ChipOption<V extends string> = { value: V; label: string };

/** A labelled, wrapping single-choice chip group (filters / sort). RTL-aware; every chip is at least 44 px tall. */
export function ChipRow<V extends string>({ label, options, value, onChange, isRTL }: { label: string; options: ChipOption<V>[]; value: V; onChange: (v: V) => void; isRTL: boolean }) {
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <AppText variant="label" muted isRTL={isRTL}>
        {label}
      </AppText>
      <View style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl]}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={o.value} onPress={() => onChange(o.value)} style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !on && styles.pressed]} accessibilityLabel={o.label} {...selectionA11y("radio", on)}>
              <AppText variant="tab" style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                {o.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: theme.spacing.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
  rowRtl: { flexDirection: "row-reverse" },
  chip: {
    minHeight: theme.controls.minTouch,
    minWidth: theme.controls.minTouch,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  chipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  pressed: { opacity: 0.85 },
  chipText: { color: theme.colors.text },
  chipTextOn: { color: theme.colors.ctaText },
});
