import { StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { DatePickerField } from "./DatePickerField";
import { InlineTimePickerField } from "./InlineTimePickerField";

type Props = {
  date: string;
  time: string;
  onDateChange: (isoDate: string) => void;
  onTimeChange: (hhmm: string) => void;
  dateLabel: string;
  timeLabel: string;
  minimumDate?: Date;
  maximumDate?: Date;
};

/** Date + time as one grouped control — same pickers, cleaner layout. */
export function SessionWhenFields({
  date,
  time,
  onDateChange,
  onTimeChange,
  dateLabel,
  timeLabel,
  minimumDate,
  maximumDate,
}: Props) {
  return (
    <View style={styles.panel}>
      <View style={styles.cell}>
        <DatePickerField
          appearance="embedded"
          label={dateLabel}
          value={date}
          onChange={onDateChange}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
        />
      </View>
      <View style={styles.divider} />
      <View style={styles.cell}>
        <InlineTimePickerField appearance="embedded" label={timeLabel} value={time} onChange={onTimeChange} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  cell: {
    paddingHorizontal: theme.spacing.sm + 4,
    paddingVertical: 10,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginHorizontal: theme.spacing.sm + 4,
  },
});
