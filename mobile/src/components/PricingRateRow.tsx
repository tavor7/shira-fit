import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { PricingRowMoreMenu } from "./PricingRowMoreMenu";

type Props = {
  title: string;
  subtitle?: string;
  priceLabel: string;
  rangeLabel: string;
  editLabel: string;
  removeLabel: string;
  moreMenuLabel: string;
  closeLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  isRTL?: boolean;
  muted?: boolean;
  /** Optional link below the row (e.g. show ended periods). */
  footerLink?: { label: string; onPress: () => void };
};

export function PricingRateRow({
  title,
  subtitle,
  priceLabel,
  rangeLabel,
  editLabel,
  removeLabel,
  moreMenuLabel,
  closeLabel,
  onEdit,
  onRemove,
  isRTL,
  muted,
  footerLink,
}: Props) {
  return (
    <View style={[styles.wrap, muted && styles.muted]}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        <View style={styles.main}>
          <View style={[styles.top, isRTL && styles.topRtl]}>
            <Text style={[styles.title, isRTL && styles.rtl]} numberOfLines={2}>
              {title}
            </Text>
            <Text style={[styles.price, isRTL && styles.rtl]}>{priceLabel}</Text>
          </View>
          {subtitle ? (
            <Text style={[styles.subtitle, isRTL && styles.rtl]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <Text style={[styles.range, isRTL && styles.rtl]} numberOfLines={1}>
            {rangeLabel}
          </Text>
        </View>
        <PricingRowMoreMenu
          editLabel={editLabel}
          removeLabel={removeLabel}
          onEdit={onEdit}
          onRemove={onRemove}
          menuAccessibilityLabel={moreMenuLabel}
          closeAccessibilityLabel={closeLabel}
          isRTL={isRTL}
        />
      </View>
      {footerLink ? (
        <Pressable
          onPress={footerLink.onPress}
          style={({ pressed }) => [styles.footerLink, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.footerLinkTxt}>{footerLink.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  muted: { opacity: 0.65 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  rowRtl: { flexDirection: "row-reverse" },
  main: { flex: 1, minWidth: 0, gap: 2 },
  top: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  topRtl: { flexDirection: "row-reverse" },
  title: { flex: 1, fontSize: 15, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  price: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flexShrink: 0 },
  subtitle: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  range: { fontSize: 12, fontWeight: "500", color: theme.colors.textSoft },
  footerLink: { marginTop: 6, paddingVertical: 2 },
  footerLinkTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
