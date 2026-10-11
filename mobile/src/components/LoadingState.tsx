import { ActivityIndicator, View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { AppIcon } from "./AppIcon";
import { useI18n } from "../context/I18nContext";
import { useIsOffline, useRegisterLoadingPlaceholder } from "../lib/networkStatus";

type Props = {
  label: string;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Centered spinner + caption for one-off transitional screens (not lists — use Skeleton for those). */
export function LoadingState({ label, isRTL, style }: Props) {
  useRegisterLoadingPlaceholder();
  const offline = useIsOffline();
  const { t } = useI18n();
  return (
    <View style={[styles.wrap, style]} accessibilityLiveRegion="polite">
      {offline ? (
        <AppIcon name="cloud-offline-outline" size="lg" color={theme.colors.warning} />
      ) : (
        <ActivityIndicator size="large" color={theme.colors.cta} />
      )}
      <AppText variant="body" muted isRTL={isRTL} style={styles.label}>
        {offline ? t("network.offlineLoading") : label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  label: { marginTop: 12, textAlign: "center" },
});
