import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

type Props = {
  compact?: boolean;
};

/** Staff calendar: marks sessions that belong to an active weekly series. */
export function SessionSeriesIndicator({ compact }: Props) {
  const { t } = useI18n();
  return (
    <View
      style={[styles.badge, compact && styles.badgeCompact]}
      accessibilityRole="image"
      accessibilityLabel={t("session.seriesBadge")}
    >
      <Text style={[styles.icon, compact && styles.iconCompact]}>↻</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.cta,
  },
  badgeCompact: {
    width: 17,
    height: 17,
  },
  icon: {
    color: theme.colors.cta,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 14,
    marginTop: -1,
  },
  iconCompact: {
    fontSize: 10,
    lineHeight: 12,
  },
});
