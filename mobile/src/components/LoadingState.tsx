import { ActivityIndicator, View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";

type Props = {
  label: string;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Centered spinner + caption for one-off transitional screens (not lists — use Skeleton for those). */
export function LoadingState({ label, isRTL, style }: Props) {
  return (
    <View style={[styles.wrap, style]}>
      <ActivityIndicator size="large" color={theme.colors.cta} />
      <AppText variant="body" muted isRTL={isRTL} style={styles.label}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  label: { marginTop: 12, textAlign: "center" },
});
