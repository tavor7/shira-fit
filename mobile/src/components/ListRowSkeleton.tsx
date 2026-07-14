import { View, StyleSheet } from "react-native";
import { theme } from "../theme";
import { Skeleton } from "./Skeleton";

/** Loading placeholder shaped like a generic list row (DaySessionSheetRow-style): leading block + two text lines. */
export function ListRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={44} height={44} radius={theme.radius.md} />
      <View style={styles.lines}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="35%" height={11} style={styles.subline} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minHeight: 64,
  },
  lines: { flex: 1, gap: 6 },
  subline: { marginTop: 0 },
});
