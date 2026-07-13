import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { theme } from "../theme";
import { parseMoney } from "../lib/participantHistoryHelpers";
import { resolveFamilyMemberByPayee, type AthleteFamily } from "../lib/athleteFamilies";
import { formatISODateFullWithWeekdayAfter } from "../lib/dateFormat";
import { paymentMethodHistoryLabel } from "../lib/paymentMethod";
import { firstWordOfDisplayName } from "../lib/displayName";
import type { AthleteAccountPayment } from "../types/database";
import type { LanguageCode } from "../i18n/translations";
import { participantHistoryStyles as styles } from "../screens/participantHistoryStyles";

type Props = {
  pay: AthleteAccountPayment;
  familyContext: AthleteFamily | null;
  isRTL: boolean;
  rtlRowFlip: boolean;
  language: LanguageCode;
  t: (key: string) => string;
  deletingPaymentId: string | null;
  onEdit: (pay: AthleteAccountPayment) => void;
  onDelete: (paymentId: string) => void;
};

export function PaymentHistoryRow({
  pay,
  familyContext,
  isRTL,
  rtlRowFlip,
  language,
  t,
  deletingPaymentId,
  onEdit,
  onDelete,
}: Props) {
  const p = pay;
  const amt = parseMoney(p.amount_ils);
  const amtTxt = amt !== null && amt > 0 ? `${amt} ₪` : "—";
  const busyPay = deletingPaymentId === p.id;
  const recorder = (p.created_by_name ?? "").trim();
  const reporterLine = recorder
    ? t("participantHistory.reportedBy").replace("{name}", firstWordOfDisplayName(recorder))
    : t("participantHistory.reportedByUnknown");
  const payeeMember = resolveFamilyMemberByPayee(familyContext, p.payee_id, p.payee_is_manual);
  const assignedName = payeeMember?.name?.trim() || null;
  const payerName = (p.payer_name ?? "").trim();
  return (
    <View style={styles.row}>
      <View style={[styles.sessionCardBody, isRTL && styles.sessionCardBodyRtl]}>
        {isRTL ? (
          <View style={[styles.sessionHeadRow, rtlRowFlip && styles.sessionHeadRowRtl]}>
            <Text style={[styles.cardDate, styles.rtlText, styles.sessionHeadMainFlex]} numberOfLines={2}>
              {formatISODateFullWithWeekdayAfter(p.paid_at, language)}
            </Text>
            <Text style={[styles.sessionAmount, styles.ltrText]}>{amtTxt}</Text>
          </View>
        ) : (
          <View style={styles.sessionHeadRow}>
            <Text style={styles.cardDate} numberOfLines={1}>
              {formatISODateFullWithWeekdayAfter(p.paid_at, language)}
            </Text>
            <Text style={styles.sessionAmount}>{amtTxt}</Text>
          </View>
        )}
        <Text style={[styles.sessionSubline, isRTL && styles.rtlText]} numberOfLines={1}>
          {t("billing.accountPayment")} · {paymentMethodHistoryLabel(p.payment_method, language)}
        </Text>
        {familyContext && assignedName ? (
          <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]} numberOfLines={1}>
            {t("families.assignedTo").replace("{name}", assignedName)}
          </Text>
        ) : null}
        {familyContext && payerName ? (
          <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]} numberOfLines={1}>
            {t("families.paidBy").replace("{name}", payerName)}
          </Text>
        ) : null}
        <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]} numberOfLines={2}>
          {reporterLine}
        </Text>
        {(p.note ?? "").trim().length > 0 ? (
          <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]}>{p.note}</Text>
        ) : null}
      </View>
      <View style={[styles.actionBar, rtlRowFlip && styles.actionBarRtl]}>
        <Pressable
          onPress={() => {
            onEdit(p);
          }}
          disabled={busyPay}
          style={({ pressed }) => [styles.actionBarItem, pressed && !busyPay && styles.actionBarItemPressed]}
        >
          <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]}>{t("participantHistory.editShort")}</Text>
        </Pressable>
        <View style={styles.actionBarSep} />
        <Pressable
          onPress={() => onDelete(p.id)}
          disabled={busyPay}
          style={({ pressed }) => [
            styles.actionBarItem,
            styles.actionBarItemDanger,
            pressed && !busyPay && styles.actionBarItemPressed,
          ]}
        >
          {busyPay ? (
            <ActivityIndicator size="small" color={theme.colors.error} />
          ) : (
            <Text style={[styles.actionBarLabelDanger, isRTL && styles.rtlText]}>
              {t("participantHistory.removeShort")}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
