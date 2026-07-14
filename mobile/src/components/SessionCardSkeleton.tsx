import { View, StyleSheet } from "react-native";
import { theme } from "../theme";
import { Skeleton } from "./Skeleton";

/** Loading placeholder shaped like SessionAgendaCardContent — time row, trainer line, chip row. */
export function SessionCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width={54} height={15} />
      <Skeleton width="60%" height={12} style={styles.trainer} />
      <View style={styles.chips}>
        <Skeleton width={48} height={18} radius={theme.radius.full} />
        <Skeleton width={48} height={18} radius={theme.radius.full} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  trainer: { marginTop: 6 },
  chips: { flexDirection: "row", gap: 6, marginTop: 8 },
});
