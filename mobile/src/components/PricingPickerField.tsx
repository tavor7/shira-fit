import { View, Text, Pressable } from "react-native";
import { pricingScreenStyles as ps } from "./pricingScreenStyles";

type Props = {
  label: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  isRTL?: boolean;
  accessibilityLabel: string;
};

export function PricingPickerField({ label, value, placeholder, onPress, isRTL, accessibilityLabel }: Props) {
  return (
    <View>
      <Text style={[ps.label, isRTL && ps.rtl]}>{label}</Text>
      <Pressable
        style={ps.pickerTouch}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <Text style={value ? ps.pickerText : ps.pickerPlaceholder} numberOfLines={2}>
          {value || placeholder}
        </Text>
      </Pressable>
    </View>
  );
}
