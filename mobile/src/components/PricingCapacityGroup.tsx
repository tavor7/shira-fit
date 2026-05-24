import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import type { PricingRateTierRow } from "../lib/pricingRates";
import { splitPricingPeriods } from "../lib/pricingRates";
import { PricingPeriodLine } from "./PricingPeriodLine";

type PeriodRow = PricingRateTierRow & { id?: string };

type Props<T extends PeriodRow> = {
  title: string;
  subtitle?: string;
  periods: T[];
  formatRange: (from: string | undefined, to: string | null | undefined) => string;
  showEndedLabel: (count: number) => string;
  hideEndedLabel: string;
  editLabel: string;
  removeLabel: string;
  onEdit: (row: T) => void;
  onRemove: (row: T) => void;
  isRTL?: boolean;
};

/** One capacity tier: shows only current/upcoming rates; ended periods stay hidden unless expanded. */
export function PricingCapacityGroup<T extends PeriodRow>({
  title,
  subtitle,
  periods,
  formatRange,
  showEndedLabel,
  hideEndedLabel,
  editLabel,
  removeLabel,
  onEdit,
  onRemove,
  isRTL,
}: Props<T>) {
  const { active, past } = useMemo(() => splitPricingPeriods(periods), [periods]);
  const [showPast, setShowPast] = useState(false);

  if (active.length === 0) return null;

  const priceFor = (row: T) => {
    const n = Number(row.price_ils);
    return Number.isFinite(n) ? `${n} ₪` : `${row.price_ils}`;
  };

  const renderLine = (row: T, muted?: boolean) => (
    <PricingPeriodLine
      key={row.id ?? `${row.max_participants}-${row.effective_from}`}
      priceLabel={priceFor(row)}
      rangeLabel={formatRange(row.effective_from, row.effective_to)}
      onEdit={() => onEdit(row)}
      onRemove={() => onRemove(row)}
      editLabel={editLabel}
      removeLabel={removeLabel}
      isRTL={isRTL}
      muted={muted}
    />
  );

  const sole = active.length === 1 ? active[0]! : null;

  return (
    <View style={styles.card}>
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <View style={styles.headerText}>
          <Text style={[styles.title, isRTL && styles.rtl]} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, isRTL && styles.rtl]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {sole ? <Text style={[styles.headerPrice, isRTL && styles.rtl]}>{priceFor(sole)}</Text> : null}
      </View>

      <View style={styles.body}>
        {sole ? (
          <>
            <Text style={[styles.soleRange, isRTL && styles.rtl]} numberOfLines={1}>
              {formatRange(sole.effective_from, sole.effective_to)}
            </Text>
            <View style={[styles.soleActions, isRTL && styles.soleActionsRtl]}>
              <Pressable onPress={() => onEdit(sole)} hitSlop={8}>
                <Text style={styles.actionEdit}>{editLabel}</Text>
              </Pressable>
              <Text style={styles.actionSep}>·</Text>
              <Pressable onPress={() => onRemove(sole)} hitSlop={8}>
                <Text style={styles.actionRemove}>{removeLabel}</Text>
              </Pressable>
            </View>
          </>
        ) : (
          active.map((row) => renderLine(row))
        )}

        {past.length > 0 ? (
          showPast ? (
            <View style={styles.pastBlock}>
              {past.map((row) => renderLine(row, true))}
              <Pressable onPress={() => setShowPast(false)} style={styles.pastToggle}>
                <Text style={styles.pastToggleTxt}>{hideEndedLabel}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setShowPast(true)} style={styles.pastToggle}>
              <Text style={styles.pastToggleTxt}>{showEndedLabel(past.length)}</Text>
            </Pressable>
          )
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerText: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 15, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  subtitle: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  headerPrice: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flexShrink: 0 },
  body: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 4,
  },
  soleRange: { fontSize: 12, color: theme.colors.textSoft, fontWeight: "500" },
  soleActions: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  soleActionsRtl: { flexDirection: "row-reverse" },
  actionEdit: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  actionRemove: { fontSize: 12, fontWeight: "700", color: theme.colors.error },
  actionSep: { fontSize: 12, color: theme.colors.textSoft },
  pastBlock: {
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    gap: 2,
  },
  pastToggle: { paddingTop: 6, paddingBottom: 2 },
  pastToggleTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
