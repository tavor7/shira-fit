import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { useI18n } from "../context/I18nContext";
import { SESSION_MAX_PRESETS } from "../lib/sessionCapacityOptions";

type Props = {
  duration: string;
  max: string;
  onDurationChange: (v: string) => void;
  onMaxChange: (v: string) => void;
  durationLabel: string;
  maxLabel: string;
};

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Text inputs for duration + max size side by side, with quick picks for common group sizes. */
export function SessionCapacityFields({
  duration,
  max,
  onDurationChange,
  onMaxChange,
  durationLabel,
  maxLabel,
}: Props) {
  const { isRTL } = useI18n();
  const maxNum = parseInt(max.trim(), 10);

  return (
    <View style={sf.formPanel}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        <View style={styles.col}>
          <Text style={[sf.label, isRTL && sf.labelRtl]}>{durationLabel}</Text>
          <TextInput
            style={[sf.control, sf.controlInput, styles.input, isRTL && styles.inputRtl]}
            value={duration}
            onChangeText={(v) => onDurationChange(digitsOnly(v).slice(0, 3))}
            keyboardType="number-pad"
            placeholder="55"
            placeholderTextColor={theme.colors.textSoft}
            accessibilityLabel={durationLabel}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.col}>
          <Text style={[sf.label, isRTL && sf.labelRtl]}>{maxLabel}</Text>
          <TextInput
            style={[sf.control, sf.controlInput, styles.input, isRTL && styles.inputRtl]}
            value={max}
            onChangeText={(v) => onMaxChange(digitsOnly(v).slice(0, 2))}
            keyboardType="number-pad"
            placeholder="1"
            placeholderTextColor={theme.colors.textSoft}
            accessibilityLabel={maxLabel}
          />
          <View style={[styles.presetRow, isRTL && styles.presetRowRtl]}>
            {SESSION_MAX_PRESETS.map((n) => {
              const on = maxNum === n;
              return (
                <Pressable
                  key={n}
                  onPress={() => onMaxChange(String(n))}
                  style={({ pressed }) => [
                    styles.presetChip,
                    on && styles.presetChipOn,
                    pressed && !on && styles.presetChipPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={String(n)}
                >
                  <Text style={[styles.presetChipTxt, on && styles.presetChipTxtOn]}>{n}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingVertical: 12,
  },
  rowRtl: { flexDirection: "row-reverse" },
  col: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    gap: 6,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: 4,
  },
  input: {
    minHeight: 44,
  },
  inputRtl: { textAlign: "right" },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  presetRowRtl: { flexDirection: "row-reverse" },
  presetChip: {
    flex: 1,
    minWidth: 36,
    height: 34,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  presetChipOn: {
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.cta,
  },
  presetChipPressed: { opacity: 0.88 },
  presetChipTxt: {
    fontSize: 14,
    fontWeight: "800",
    color: theme.colors.textMuted,
  },
  presetChipTxtOn: { color: theme.colors.ctaText },
});
