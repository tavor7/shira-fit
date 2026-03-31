export type DatePickerFieldProps = {
  label: string;
  /** YYYY-MM-DD */
  value: string;
  onChange: (isoDate: string) => void;
  minimumDate?: Date;
  maximumDate?: Date;
};
