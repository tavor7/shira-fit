import { StyleSheet, View } from "react-native";
import { sessionFormStyles as sf } from "./sessionFormStyles";
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
    <View style={sf.formPanel}>
      <View style={sf.formPanelCell}>
        <DatePickerField
          appearance="embedded"
          label={dateLabel}
          value={date}
          onChange={onDateChange}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
        />
      </View>
      <View style={sf.formPanelDivider} />
      <View style={sf.formPanelCell}>
        <InlineTimePickerField appearance="embedded" label={timeLabel} value={time} onChange={onTimeChange} />
      </View>
    </View>
  );
}
