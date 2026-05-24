import { View, Text, StyleSheet } from "react-native";
import { DatePickerField } from "./DatePickerField";
import { pricingScreenStyles as ps } from "./pricingScreenStyles";
import { theme } from "../theme";

type Props = {
  fromLabel: string;
  toLabel: string;
  toHint?: string;
  fromValue: string;
  toValue: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  isRTL?: boolean;
};

export function PricingRatePeriodFields({
  fromLabel,
  toLabel,
  toHint,
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  isRTL,
}: Props) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        <View style={styles.field}>
          <DatePickerField label={fromLabel} value={fromValue} onChange={onFromChange} />
        </View>
        <View style={styles.field}>
          <DatePickerField label={toLabel} value={toValue} onChange={onToChange} />
        </View>
      </View>
      {toHint ? <Text style={[styles.hint, isRTL && ps.rtl]}>{toHint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: theme.spacing.xs },
  row: { flexDirection: "row", gap: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  field: { flex: 1, minWidth: 0 },
  hint: { fontSize: 12, color: theme.colors.textSoft, lineHeight: 17 },
});
