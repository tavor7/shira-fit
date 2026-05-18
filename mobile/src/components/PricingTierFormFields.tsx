import { View, Text, TextInput, StyleSheet } from "react-native";
import { theme } from "../theme";
import { pricingScreenStyles as ps } from "./pricingScreenStyles";

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  keyboardType: "number-pad" | "decimal-pad";
  accessibilityLabel: string;
  editable?: boolean;
  isRTL?: boolean;
};

type Props = {
  capacityLabel: string;
  priceLabel: string;
  capValue: string;
  priceValue: string;
  onCapChange: (v: string) => void;
  onPriceChange: (v: string) => void;
  capPlaceholder?: string;
  pricePlaceholder?: string;
  editable?: boolean;
  isRTL?: boolean;
};

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  accessibilityLabel,
  editable = true,
  isRTL,
}: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={[ps.label, isRTL && ps.rtl]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textSoft}
        style={[ps.input, !editable && styles.inputDisabled]}
        editable={editable}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

export function PricingTierFormFields({
  capacityLabel,
  priceLabel,
  capValue,
  priceValue,
  onCapChange,
  onPriceChange,
  capPlaceholder = "8",
  pricePlaceholder = "120",
  editable = true,
  isRTL,
}: Props) {
  return (
    <View style={[styles.row, isRTL && styles.rowRtl]}>
      <Field
        label={capacityLabel}
        value={capValue}
        onChangeText={onCapChange}
        placeholder={capPlaceholder}
        keyboardType="number-pad"
        accessibilityLabel={capacityLabel}
        editable={editable}
        isRTL={isRTL}
      />
      <Field
        label={priceLabel}
        value={priceValue}
        onChangeText={onPriceChange}
        placeholder={pricePlaceholder}
        keyboardType="decimal-pad"
        accessibilityLabel={priceLabel}
        editable={editable}
        isRTL={isRTL}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10 },
  rowRtl: { flexDirection: "row-reverse" },
  field: { flex: 1, minWidth: 0 },
  inputDisabled: { opacity: 0.55 },
});
