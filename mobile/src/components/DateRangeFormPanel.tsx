import { View } from "react-native";
import { DatePickerField } from "./DatePickerField";
import { sessionFormStyles as sf } from "./sessionFormStyles";

type Props = {
  fromLabel: string;
  toLabel: string;
  start: string;
  end: string;
  onStartChange: (iso: string) => void;
  onEndChange: (iso: string) => void;
  minimumStart?: Date;
  maximumStart?: Date;
  minimumEnd?: Date;
  maximumEnd?: Date;
};

/** Stacked from/to dates in the shared form panel (matches Reports custom range). */
export function DateRangeFormPanel({
  fromLabel,
  toLabel,
  start,
  end,
  onStartChange,
  onEndChange,
  minimumStart,
  maximumStart,
  minimumEnd,
  maximumEnd,
}: Props) {
  return (
    <View style={sf.formPanel}>
      <View style={sf.formPanelCell}>
        <DatePickerField
          appearance="embedded"
          label={fromLabel}
          value={start}
          onChange={onStartChange}
          minimumDate={minimumStart}
          maximumDate={maximumStart}
        />
      </View>
      <View style={sf.formPanelDivider} />
      <View style={sf.formPanelCell}>
        <DatePickerField
          appearance="embedded"
          label={toLabel}
          value={end}
          onChange={onEndChange}
          minimumDate={minimumEnd}
          maximumDate={maximumEnd}
        />
      </View>
    </View>
  );
}
