import { useState } from "react";
import { View, Pressable, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import type { PricingListRow, PricingRateTierRow } from "../lib/pricingRates";
import { PricingRateRow } from "./PricingRateRow";

type Props<T extends PricingRateTierRow> = {
  rows: PricingListRow<T>[];
  formatRange: (from: string | undefined, to: string | null | undefined) => string;
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

export function PricingListRows<T extends PricingRateTierRow>({
  rows,
  formatRange,
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
  const [showPast, setShowPast] = useState<Record<string, boolean>>({});

  const priceFor = (row: T) => {
    const n = Number(row.price_ils);
    return Number.isFinite(n) ? `${n} ₪` : `${row.price_ils}`;
  };

  return (
    <>
      {rows.map((listRow) => {
        const pastOpen = !!showPast[listRow.groupKey];
        return (
          <View key={listRow.key}>
            <PricingRateRow
              title={listRow.title}
              subtitle={listRow.subtitle}
              priceLabel={priceFor(listRow.period)}
              rangeLabel={formatRange(listRow.period.effective_from, listRow.period.effective_to)}
              editLabel={editLabel}
              removeLabel={removeLabel}
              moreMenuLabel={moreMenuLabel}
              closeLabel={closeLabel}
              onEdit={() => onEdit(listRow.period)}
              onRemove={() => onRemove(listRow.period)}
              isRTL={isRTL}
              footerLink={
                listRow.pastCount > 0 && !pastOpen
                  ? {
                      label: showEndedLabel(listRow.pastCount),
                      onPress: () => setShowPast((s) => ({ ...s, [listRow.groupKey]: true })),
                    }
                  : undefined
              }
            />
            {pastOpen
              ? listRow.pastPeriods.map((p) => (
                  <PricingRateRow
                    key={p.id ?? `past-${listRow.groupKey}-${p.effective_from}`}
                    title={listRow.title}
                    subtitle={listRow.subtitle}
                    priceLabel={priceFor(p)}
                    rangeLabel={formatRange(p.effective_from, p.effective_to)}
                    editLabel={editLabel}
                    removeLabel={removeLabel}
                    moreMenuLabel={moreMenuLabel}
                    closeLabel={closeLabel}
                    onEdit={() => onEdit(p)}
                    onRemove={() => onRemove(p)}
                    isRTL={isRTL}
                    muted
                  />
                ))
              : null}
            {pastOpen && listRow.pastCount > 0 ? (
              <Pressable
                onPress={() => setShowPast((s) => ({ ...s, [listRow.groupKey]: false }))}
                style={styles.hidePast}
              >
                <Text style={styles.hidePastTxt}>{hideEndedLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  hidePast: { paddingHorizontal: 8, paddingBottom: 8 },
  hidePastTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
});
