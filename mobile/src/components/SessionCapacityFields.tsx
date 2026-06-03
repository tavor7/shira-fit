import { StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { NumberScrollField } from "./NumberScrollField";
import { useI18n } from "../context/I18nContext";
import { SESSION_DURATION_OPTIONS, SESSION_MAX_SIZE_OPTIONS } from "../lib/sessionCapacityOptions";

type Props = {
  duration: string;
  max: string;
  onDurationChange: (v: string) => void;
  onMaxChange: (v: string) => void;
  durationLabel: string;
  maxLabel: string;
};

/** Scrollable duration (30–120 min) + max size (1–15). */
export function SessionCapacityFields({
  duration,
  max,
  onDurationChange,
  onMaxChange,
  durationLabel,
  maxLabel,
}: Props) {
  const { isRTL } = useI18n();

  return (
    <View style={sf.formPanel}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        <View style={styles.col}>
          <NumberScrollField
            label={durationLabel}
            value={duration}
            onChange={onDurationChange}
            options={SESSION_DURATION_OPTIONS}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <NumberScrollField label={maxLabel} value={max} onChange={onMaxChange} options={SESSION_MAX_SIZE_OPTIONS} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "stretch" },
  rowRtl: { flexDirection: "row-reverse" },
  col: { flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 12 },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: 10,
  },
});
