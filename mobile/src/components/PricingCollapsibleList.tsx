import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { PricingListRow, PricingListCluster, PricingRateTierRow } from "../lib/pricingRates";
import { clusterPricingListRows, formatPricingEffectiveRange } from "../lib/pricingRates";
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

function RatePeriodLines({
  period,
  tierLine,
  isRTL,
  presentLabel,
  language,
}: {
  period: PricingRateTierRow;
  tierLine: string;
  isRTL?: boolean;
  presentLabel: string;
  language: "en" | "he";
}) {
  const dates =
    period.effective_from != null
      ? formatPricingEffectiveRange(period.effective_from, period.effective_to, language, presentLabel)
      : null;

  return (
    <View style={[styles.rateTextCol, isRTL && styles.rateTextColRtl]}>
      <Text style={[styles.tierLine, isRTL && styles.rtl]} numberOfLines={2}>
        {tierLine}
      </Text>
      {dates ? (
        <Text style={[styles.dateLine, isRTL && styles.rtl]} numberOfLines={1}>
          {dates}
        </Text>
      ) : null}
    </View>
  );
}

function RateRowCard<T extends PricingRateTierRow>({
  period,
  tierLine,
  isRTL,
  presentLabel,
  language,
  editLabel,
  removeLabel,
  moreMenuLabel,
  closeLabel,
  onEdit,
  onRemove,
  muted,
}: {
  period: T;
  tierLine: string;
  isRTL?: boolean;
  presentLabel: string;
  language: "en" | "he";
  editLabel: string;
  removeLabel: string;
  moreMenuLabel: string;
  closeLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  muted?: boolean;
}) {
  return (
    <View style={[styles.rateCard, muted && styles.rateCardMuted, isRTL && styles.rateCardRtl]}>
      <RatePeriodLines
        period={period}
        tierLine={tierLine}
        isRTL={isRTL}
        presentLabel={presentLabel}
        language={language}
      />
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
  );
}

function ClusterBlock<T extends PricingRateTierRow>({
  cluster,
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
}: {
  cluster: PricingListCluster<T>;
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
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const primary = cluster.items[0]?.period;
  const multi = cluster.items.length > 1 || cluster.pastCount > 0;
  /** Athlete list: always use name + chevron row (even for a single rate). */
  const collapsibleHeader = clusterMode === "title" || multi;
  const expandLabel = expanded ? t("pricing.collapseRates") : t("pricing.expandRates");
  const presentLabel = t("pricing.effectivePresent");
  const ratesMeta = t("pricing.ratesCount").replace(/\{n\}/g, String(cluster.items.length));

  const tierLineForItem = (item: PricingListRow<T>) => {
    const tier = item.subtitle ?? (clusterMode === "groupKey" ? item.title : null);
    const price = priceLabel(item.period);
    return tier ? `${tier} · ${price}` : price;
  };

  return (
    <View style={styles.cluster}>
      {collapsibleHeader ? (
        <View style={[styles.header, isRTL && styles.headerRtl]}>
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            style={({ pressed }) => [
              styles.headerMain,
              isRTL && styles.headerMainRtl,
              pressed && { opacity: 0.9 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expandLabel}
          >
            <Text style={[styles.headerTitle, isRTL && styles.rtl]} numberOfLines={2}>
              {cluster.title}
            </Text>
            <Text style={[styles.headerMeta, isRTL && styles.rtl]}>{ratesMeta}</Text>
          </Pressable>
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={expandLabel}
            accessibilityState={{ expanded }}
          >
            <Text style={[styles.expandIcon, expanded && styles.expandIconOpen]}>{expanded ? "▴" : "▾"}</Text>
          </Pressable>
        </View>
      ) : primary ? (
        <View style={styles.body}>
          <RateRowCard
            period={primary}
            tierLine={tierLineForItem(cluster.items[0]!)}
            isRTL={isRTL}
            presentLabel={presentLabel}
            language={language}
            editLabel={editLabel}
            removeLabel={removeLabel}
            moreMenuLabel={moreMenuLabel}
            closeLabel={closeLabel}
            onEdit={() => onEdit(primary)}
            onRemove={() => onRemove(primary)}
          />
        </View>
      ) : null}

      {expanded && collapsibleHeader ? (
        <View style={styles.body}>
          {cluster.items.map((item) => (
            <RateRowCard
              key={item.key}
              period={item.period}
              tierLine={tierLineForItem(item)}
              isRTL={isRTL}
              presentLabel={presentLabel}
              language={language}
              editLabel={editLabel}
              removeLabel={removeLabel}
              moreMenuLabel={moreMenuLabel}
              closeLabel={closeLabel}
              onEdit={() => onEdit(item.period)}
              onRemove={() => onRemove(item.period)}
            />
          ))}
          {cluster.pastCount > 0 ? (
            showPast ? (
              <>
                {cluster.pastPeriods.map((p) => (
                  <RateRowCard
                    key={p.id ?? `past-${cluster.clusterKey}-${p.effective_from}`}
                    period={p}
                    tierLine={`${cluster.items[0]?.subtitle ?? cluster.title} · ${priceLabel(p)}`}
                    isRTL={isRTL}
                    presentLabel={presentLabel}
                    language={language}
                    editLabel={editLabel}
                    removeLabel={removeLabel}
                    moreMenuLabel={moreMenuLabel}
                    closeLabel={closeLabel}
                    onEdit={() => onEdit(p)}
                    onRemove={() => onRemove(p)}
                    muted
                  />
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

      {!collapsibleHeader && cluster.pastCount > 0 ? (
        <View style={styles.body}>
          {showPast ? (
            <>
              {cluster.pastPeriods.map((p) => (
                <RateRowCard
                  key={p.id ?? `past-${p.id}`}
                  period={p}
                  tierLine={`${cluster.items[0]?.subtitle ?? cluster.title} · ${priceLabel(p)}`}
                  isRTL={isRTL}
                  presentLabel={presentLabel}
                  language={language}
                  editLabel={editLabel}
                  removeLabel={removeLabel}
                  moreMenuLabel={moreMenuLabel}
                  closeLabel={closeLabel}
                  onEdit={() => onEdit(p)}
                  onRemove={() => onRemove(p)}
                  muted
                />
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
          clusterMode={clusterMode}
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
    paddingVertical: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerMain: { flex: 1, minWidth: 0, gap: 3, justifyContent: "center" },
  headerMainRtl: { alignItems: "flex-end" },
  headerTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  headerMeta: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
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
  body: { paddingBottom: 8, paddingHorizontal: 4, gap: 6 },
  rateCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rateCardRtl: { flexDirection: "row-reverse" },
  rateCardMuted: { opacity: 0.65 },
  rateTextCol: { flex: 1, minWidth: 0, gap: 4 },
  rateTextColRtl: { alignItems: "flex-end" },
  tierLine: { fontSize: 14, fontWeight: "800", color: theme.colors.text, lineHeight: 19 },
  dateLine: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, lineHeight: 16 },
  pastToggle: { paddingVertical: 6, paddingHorizontal: 8 },
  pastToggleTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
