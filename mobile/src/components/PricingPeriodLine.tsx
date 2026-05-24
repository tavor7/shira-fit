import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";

type Props = {
  priceLabel: string;
  rangeLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  editLabel: string;
  removeLabel: string;
  isRTL?: boolean;
  muted?: boolean;
};

export function PricingPeriodLine({
  priceLabel,
  rangeLabel,
  onEdit,
  onRemove,
  editLabel,
  removeLabel,
  isRTL,
  muted,
}: Props) {
  return (
    <View style={[styles.row, isRTL && styles.rowRtl, muted && styles.muted]}>
      <View style={styles.main}>
        <Text style={[styles.price, isRTL && styles.rtl]}>{priceLabel}</Text>
        <Text style={[styles.range, isRTL && styles.rtl]} numberOfLines={1}>
          {rangeLabel}
        </Text>
      </View>
      <View style={[styles.actions, isRTL && styles.actionsRtl]}>
        <Pressable onPress={onEdit} hitSlop={6} accessibilityRole="button" accessibilityLabel={editLabel}>
          <Text style={styles.actionEdit}>{editLabel}</Text>
        </Pressable>
        <Text style={styles.actionSep}>·</Text>
        <Pressable onPress={onRemove} hitSlop={6} accessibilityRole="button" accessibilityLabel={removeLabel}>
          <Text style={styles.actionRemove}>{removeLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 6,
  },
  rowRtl: { flexDirection: "row-reverse" },
  muted: { opacity: 0.65 },
  main: { flex: 1, minWidth: 0, gap: 1 },
  price: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  range: { fontSize: 12, fontWeight: "500", color: theme.colors.textSoft },
  actions: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  actionsRtl: { flexDirection: "row-reverse" },
  actionEdit: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  actionRemove: { fontSize: 12, fontWeight: "700", color: theme.colors.error },
  actionSep: { fontSize: 12, color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
