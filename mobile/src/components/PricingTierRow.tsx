import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

type Props = {
  title: string;
  priceLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  isRTL?: boolean;
};

export function PricingTierRow({ title, priceLabel, onEdit, onRemove, isRTL }: Props) {
  const { t } = useI18n();
  return (
    <View style={[styles.row, isRTL && styles.rowRtl]}>
      <Text style={[styles.rowCap, isRTL && styles.rtl]} numberOfLines={2}>
        {title}
      </Text>
      <View style={[styles.rowEnd, isRTL && styles.rowEndRtl]}>
        <View style={styles.pricePill}>
          <Text style={styles.rowPrice}>{priceLabel}</Text>
        </View>
        <View style={[styles.actions, isRTL && styles.actionsRtl]}>
          <Pressable
            onPress={onEdit}
            style={({ pressed }) => [styles.actionBtn, styles.editBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={`${t("common.edit")}: ${title}`}
          >
            <Text style={styles.editTxt}>{t("common.edit")}</Text>
          </Pressable>
          <Pressable
            onPress={onRemove}
            style={({ pressed }) => [styles.actionBtn, styles.removeBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={`${t("pricing.delete")}: ${title}`}
          >
            <Text style={styles.removeTxt}>{t("pricing.delete")}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 10,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowCap: { flex: 1, minWidth: 0, fontWeight: "700", fontSize: 14, color: theme.colors.text, lineHeight: 19 },
  rowEnd: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  rowEndRtl: { flexDirection: "row-reverse" },
  pricePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowPrice: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionsRtl: { flexDirection: "row-reverse" },
  actionBtn: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: theme.radius.sm,
  },
  editBtn: { backgroundColor: theme.colors.surfaceElevated },
  editTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 12 },
  removeBtn: {},
  removeTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 12 },
  rtl: { textAlign: "right" },
});
