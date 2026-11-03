import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { displayMoney } from "../lib/displayFormat";
import { fetchAccountBalances, type AccountBalanceMap, type AccountBalanceRow } from "../lib/paymentReminders";

/** Current balances for a search list, fetched once per screen. Null until loaded, and when the lookup failed. */
export function useAccountBalances(enabled: boolean): AccountBalanceMap | null {
  const [balances, setBalances] = useState<AccountBalanceMap | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void fetchAccountBalances().then((map) => {
      if (current) setBalances(map);
    });
    return () => {
      current = false;
    };
  }, [enabled]);
  return balances;
}

/** A search-list row's balance. A row with no finance history is even; `balance: null` is hidden from this manager, so nothing is shown. */
export function AccountBalanceChip({ row }: { row: AccountBalanceRow | undefined }) {
  const { t } = useI18n();
  const balance = row ? row.balance : 0;
  if (balance == null) return null;
  return (
    <View style={styles.wrap}>
      <Text style={[styles.amount, balance > 0 ? styles.owe : balance < 0 ? styles.credit : styles.even]}>
        {balance === 0
          ? t("billing.balanceEven")
          : balance > 0
            ? displayMoney(balance)
            : t("billing.balanceCredit").replace("{n}", displayMoney(balance * -1))}
      </Text>
      {row?.is_family ? <Text style={[styles.tag, styles.tagInfo]}>{t("paymentReminder.familyTag")}</Text> : null}
      {row?.has_pending ? <Text style={[styles.tag, styles.tagInfo]}>{t("paymentReminder.pendingTag")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexShrink: 0, maxWidth: "45%", alignItems: "flex-end", gap: 4 },
  amount: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  owe: { color: theme.colors.error },
  credit: { color: theme.colors.success },
  even: { color: theme.colors.textMuted },
  tag: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    overflow: "hidden",
    textAlign: "center",
  },
  tagInfo: { backgroundColor: theme.colors.infoBg, color: theme.colors.info },
});
