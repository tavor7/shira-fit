import { View, Text, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { sessionFormIsCompact } from "./sessionFormStyles";

type Props = {
  title: string;
  priceLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  isRTL?: boolean;
  /** Force stacked layout (name on top). Default: auto on narrow screens. */
  layout?: "auto" | "inline" | "stacked";
};

export function PricingTierRow({ title, priceLabel, onEdit, onRemove, isRTL, layout = "auto" }: Props) {
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const stacked = layout === "stacked" || (layout === "auto" && sessionFormIsCompact(width));

  const pricePill = (
    <View style={styles.pricePill}>
      <Text style={[styles.rowPrice, isRTL && styles.rtl]}>{priceLabel}</Text>
    </View>
  );

  const actions = (
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
  );

  if (stacked) {
    return (
      <View style={styles.rowStacked}>
        <Text style={[styles.titleStacked, isRTL && styles.rtl]}>{title}</Text>
        <View style={[styles.bottomRow, isRTL && styles.bottomRowRtl]}>
          {pricePill}
          {actions}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, isRTL && styles.rowRtl]}>
      <Text style={[styles.rowCap, isRTL && styles.rtl]} numberOfLines={2}>
        {title}
      </Text>
      <View style={[styles.rowEnd, isRTL && styles.rowEndRtl]}>
        {pricePill}
        {actions}
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
  rowEnd: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 },
  rowEndRtl: { flexDirection: "row-reverse" },
  rowStacked: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 10,
  },
  titleStacked: {
    fontWeight: "800",
    fontSize: 15,
    color: theme.colors.text,
    lineHeight: 20,
    alignSelf: "stretch",
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  bottomRowRtl: { flexDirection: "row-reverse" },
  pricePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    flexShrink: 1,
    maxWidth: "100%",
  },
  rowPrice: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  actions: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
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
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
