import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { PricingListRow, PricingListCluster, PricingRateTierRow } from "../lib/pricingRates";
import { clusterPricingListRows } from "../lib/pricingRates";
import { PricingRowMoreMenu } from "./PricingRowMoreMenu";

type Props<T extends PricingRateTierRow> = {
  rows: PricingListRow<T>[];
  /** `groupKey` = one row per capacity; `title` = one row per athlete name. */
  clusterMode: "groupKey" | "title";
  showEndedLabel: (count: number) => string;
  hideEndedLabel: string;
  editLabel: string;
  removeLabel: string;
  moreMenuLabel: string;
  closeLabel: string;
  onEdit: (row: T) => void;
  onRemove: (row: T) => void;
  isRTL?: boolean;
};

function priceLabel(row: PricingRateTierRow) {
  const n = Number(row.price_ils);
  return Number.isFinite(n) ? `${n} ₪` : `${row.price_ils}`;
}

function ClusterBlock<T extends PricingRateTierRow>({
  cluster,
  showEndedLabel,
  hideEndedLabel,
  editLabel,
  removeLabel,
  moreMenuLabel,
  closeLabel,
  onEdit,
  onRemove,
  isRTL,
}: {
  cluster: PricingListCluster<T>;
  showEndedLabel: (count: number) => string;
  hideEndedLabel: string;
  editLabel: string;
  removeLabel: string;
  moreMenuLabel: string;
  closeLabel: string;
  onEdit: (row: T) => void;
  onRemove: (row: T) => void;
  isRTL?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const primary = cluster.items[0]?.period;
  const headerPrice = primary ? priceLabel(primary) : "";
  const multi = cluster.items.length > 1 || cluster.pastCount > 0;
  const expandLabel = expanded ? t("pricing.collapseRates") : t("pricing.expandRates");

  return (
    <View style={styles.cluster}>
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Pressable
          onPress={() => multi && setExpanded((e) => !e)}
          disabled={!multi}
          style={({ pressed }) => [
            styles.headerMain,
            isRTL && styles.headerMainRtl,
            pressed && multi && { opacity: 0.9 },
          ]}
          accessibilityRole={multi ? "button" : "none"}
          accessibilityState={{ expanded: multi ? expanded : undefined }}
          accessibilityLabel={multi ? expandLabel : cluster.title}
        >
          <Text style={[styles.headerTitle, isRTL && styles.rtl]} numberOfLines={2}>
            {cluster.title}
          </Text>
          {multi ? (
            <Text style={[styles.headerMeta, isRTL && styles.rtl]}>
              {t("pricing.ratesCount").replace(/\{n\}/g, String(cluster.items.length))}
            </Text>
          ) : null}
        </Pressable>
        {!multi && headerPrice ? (
          <Text style={[styles.headerPriceInline, isRTL && styles.rtl]}>{headerPrice}</Text>
        ) : null}
        {multi ? (
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={expandLabel}
            accessibilityState={{ expanded }}
          >
            <Text style={[styles.expandIcon, expanded && styles.expandIconOpen]}>{expanded ? "▴" : "▾"}</Text>
          </Pressable>
        ) : primary ? (
          <PricingRowMoreMenu
            editLabel={editLabel}
            removeLabel={removeLabel}
            onEdit={() => onEdit(primary)}
            onRemove={() => onRemove(primary)}
            menuAccessibilityLabel={moreMenuLabel}
            closeAccessibilityLabel={closeLabel}
            isRTL={isRTL}
          />
        ) : null}
      </View>

      {expanded && multi ? (
        <View style={styles.body}>
          {cluster.items.map((item) => {
            const lineTitle = item.subtitle ?? item.title;
            return (
              <View key={item.key} style={[styles.innerRow, isRTL && styles.innerRowRtl]}>
                <Text style={[styles.innerLabel, isRTL && styles.rtl]} numberOfLines={1}>
                  {lineTitle} · {priceLabel(item.period)}
                </Text>
                <PricingRowMoreMenu
                  editLabel={editLabel}
                  removeLabel={removeLabel}
                  onEdit={() => onEdit(item.period)}
                  onRemove={() => onRemove(item.period)}
                  menuAccessibilityLabel={moreMenuLabel}
                  closeAccessibilityLabel={closeLabel}
                  isRTL={isRTL}
                />
              </View>
            );
          })}
          {cluster.pastCount > 0 ? (
            showPast ? (
              <>
                {cluster.pastPeriods.map((p) => (
                  <View
                    key={p.id ?? `past-${cluster.clusterKey}-${p.effective_from}`}
                    style={[styles.innerRow, styles.innerMuted, isRTL && styles.innerRowRtl]}
                  >
                    <Text style={[styles.innerLabel, isRTL && styles.rtl]} numberOfLines={1}>
                      {(cluster.items[0]?.subtitle ?? cluster.title) + " · " + priceLabel(p)}
                    </Text>
                    <PricingRowMoreMenu
                      editLabel={editLabel}
                      removeLabel={removeLabel}
                      onEdit={() => onEdit(p)}
                      onRemove={() => onRemove(p)}
                      menuAccessibilityLabel={moreMenuLabel}
                      closeAccessibilityLabel={closeLabel}
                      isRTL={isRTL}
                    />
                  </View>
                ))}
                <Pressable onPress={() => setShowPast(false)} style={styles.pastToggle}>
                  <Text style={styles.pastToggleTxt}>{hideEndedLabel}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable onPress={() => setShowPast(true)} style={styles.pastToggle}>
                <Text style={styles.pastToggleTxt}>{showEndedLabel(cluster.pastCount)}</Text>
              </Pressable>
            )
          ) : null}
        </View>
      ) : null}

      {!multi && cluster.pastCount > 0 ? (
        <View style={styles.body}>
          {showPast ? (
            <>
              {cluster.pastPeriods.map((p) => (
                <View key={p.id ?? `past-${p.id}`} style={[styles.innerRow, styles.innerMuted, isRTL && styles.innerRowRtl]}>
                  <Text style={[styles.innerLabel, isRTL && styles.rtl]} numberOfLines={1}>
                    {cluster.title} · {priceLabel(p)}
                  </Text>
                  <PricingRowMoreMenu
                    editLabel={editLabel}
                    removeLabel={removeLabel}
                    onEdit={() => onEdit(p)}
                    onRemove={() => onRemove(p)}
                    menuAccessibilityLabel={moreMenuLabel}
                    closeAccessibilityLabel={closeLabel}
                    isRTL={isRTL}
                  />
                </View>
              ))}
              <Pressable onPress={() => setShowPast(false)} style={styles.pastToggle}>
                <Text style={styles.pastToggleTxt}>{hideEndedLabel}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable onPress={() => setShowPast(true)} style={styles.pastToggle}>
              <Text style={styles.pastToggleTxt}>{showEndedLabel(cluster.pastCount)}</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

export function PricingCollapsibleList<T extends PricingRateTierRow>({
  rows,
  clusterMode,
  showEndedLabel,
  hideEndedLabel,
  editLabel,
  removeLabel,
  moreMenuLabel,
  closeLabel,
  onEdit,
  onRemove,
  isRTL,
}: Props<T>) {
  const clusters = useMemo(() => clusterPricingListRows(rows, clusterMode), [rows, clusterMode]);

  return (
    <View style={styles.list}>
      {clusters.map((cluster) => (
        <ClusterBlock
          key={cluster.clusterKey}
          cluster={cluster}
          showEndedLabel={showEndedLabel}
          hideEndedLabel={hideEndedLabel}
          editLabel={editLabel}
          removeLabel={removeLabel}
          moreMenuLabel={moreMenuLabel}
          closeLabel={closeLabel}
          onEdit={onEdit}
          onRemove={onRemove}
          isRTL={isRTL}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0 },
  cluster: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerMain: { flex: 1, minWidth: 0, gap: 3, justifyContent: "center" },
  headerMainRtl: { alignItems: "flex-end" },
  headerTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  headerMeta: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  headerPrice: { fontSize: 16, fontWeight: "800", color: theme.colors.text, marginTop: 1 },
  headerPriceInline: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
    flexShrink: 0,
    marginHorizontal: 4,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    flexShrink: 0,
  },
  expandIcon: { fontSize: 14, fontWeight: "800", color: theme.colors.textMuted, lineHeight: 16 },
  expandIconOpen: { color: theme.colors.text },
  body: { paddingBottom: 8, paddingHorizontal: 4, gap: 4 },
  innerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
  },
  innerRowRtl: { flexDirection: "row-reverse" },
  innerMuted: { opacity: 0.65 },
  innerLabel: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.colors.text },
  pastToggle: { paddingVertical: 6, paddingHorizontal: 8 },
  pastToggleTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
