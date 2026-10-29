import { View, Text } from "react-native";
import { parseMoney } from "../lib/participantHistoryHelpers";
import { formatISODateWeekdayDayMonthYear } from "../lib/dateFormat";
import type { SubscriptionChargeHistoryRow as SubscriptionCharge } from "../types/database";
import type { LanguageCode } from "../i18n/translations";
import { participantHistoryStyles as styles } from "../screens/participantHistoryStyles";
import { displayMoney } from "../lib/displayFormat";

type Props = {
  charge: SubscriptionCharge;
  isRTL: boolean;
  language: LanguageCode;
  t: (key: string) => string;
};

const LABEL_KEY_BY_TYPE: Record<SubscriptionCharge["charge_type"], string> = {
  recurring: "billing.subscriptionChargeRecurring",
  proration: "billing.subscriptionChargeProration",
  freeze_credit: "billing.subscriptionChargeFreezeCredit",
  stop_proration: "billing.subscriptionChargeStopProration",
  reversal: "billing.subscriptionChargeReversal",
};

// Display-only: this amount is already folded into computeBillingSummary's subscriptionChargesIls.
// Color semantics: a charge increases what's owed (amber, ▲), never green -- green is reserved for
// actual cash received (see PaymentHistoryRow). A credit/reversal reduces what's owed (muted, ▽):
// it isn't a payment either, since no cash moved.
export function SubscriptionChargeHistoryRow({ charge, isRTL, language, t }: Props) {
  const amt = parseMoney(charge.amount_ils) ?? 0;
  const isNegative = amt < 0;
  const amtTxt = displayMoney(Math.abs(amt));
  const label = t(LABEL_KEY_BY_TYPE[charge.charge_type] ?? "billing.subscriptionChargeRecurring");
  const amountStyle = isNegative ? styles.sessionAmountNeutral : styles.sessionAmountCharge;
  const glyph = isNegative ? "▽" : "▲";
  return (
    <View style={[styles.row, isNegative && styles.rowDiscount]}>
      <View style={[styles.sessionCardBody, isRTL && styles.sessionCardBodyRtl]}>
        {isRTL ? (
          <View style={styles.sessionHeadRow}>
            <Text style={[styles.cardDate, styles.rtlText, styles.sessionHeadMainFlex]} numberOfLines={1}>
              {formatISODateWeekdayDayMonthYear(charge.period_start, language)}
            </Text>
            <Text style={[styles.sessionAmount, styles.ltrText, amountStyle]}>
              {glyph} {isNegative ? "−" : ""}
              {amtTxt}
            </Text>
          </View>
        ) : (
          <View style={styles.sessionHeadRow}>
            <Text style={styles.cardDate} numberOfLines={1}>
              {formatISODateWeekdayDayMonthYear(charge.period_start, language)}
            </Text>
            <Text style={[styles.sessionAmount, amountStyle]}>
              {glyph} {isNegative ? "−" : ""}
              {amtTxt}
            </Text>
          </View>
        )}
        <Text
          style={[styles.sessionSubline, isNegative && styles.sessionSublineDiscount, isRTL && styles.rtlText]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    </View>
  );
}
