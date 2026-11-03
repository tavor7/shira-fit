import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { rowFlipFor } from "../lib/layoutDirection";
import { displayMoney } from "../lib/displayFormat";
import { appLocale } from "../lib/appLocale";
import { parseInstantIso } from "../lib/dateFormat";
import {
  cancelPaymentReminder,
  defaultReminderRecipient,
  fetchReminderStatus,
  reminderCardState,
  sendPaymentReminder,
  type ReminderAccountStatus,
  type ReminderHistoryRow,
  type ReminderStatus,
} from "../lib/paymentReminders";
import { AppText } from "./AppText";
import { ActionButton } from "./ActionButton";
import { PrimaryButton } from "./PrimaryButton";

const STUDIO_TZ = "Asia/Jerusalem";

const NOTICE_KEY = {
  hidden: "paymentReminder.noticeHidden",
  noLogin: "paymentReminder.noticeNoLogin",
  notEligible: "paymentReminder.noticeNotEligible",
  familyEven: "paymentReminder.noticeFamilyEven",
  credit: "paymentReminder.noticeCredit",
  nothingOwed: "paymentReminder.noticeNothingOwed",
} as const;

const STATUS_KEY: Record<ReminderStatus, string> = {
  pending: "paymentReminder.statusPending",
  read: "paymentReminder.statusRead",
  cancelled: "paymentReminder.statusCancelled",
  settled: "paymentReminder.statusSettled",
  account_changed: "paymentReminder.statusAccountChanged",
};

function formatWhen(iso: string, language: "en" | "he"): string {
  const d = parseInstantIso(iso);
  if (!d) return iso;
  return d.toLocaleString(appLocale(language), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: STUDIO_TZ,
  });
}

type Props = {
  payeeId: string;
  payeeIsManual: boolean;
  /** Change this when the caller knows a payment changed, so the balance is read again. */
  refreshKey?: string | number;
  style?: StyleProp<ViewStyle>;
};

/** The current balance, independent of any report dates, with the reminder action and history. Manager only. */
export function PaymentReminderCard({ payeeId, payeeIsManual, refreshKey, style }: Props) {
  const { t, isRTL, language } = useI18n();
  const { profile } = useAuth();
  const { showToast } = useToast();
  const isManager = profile?.role === "manager";
  const [status, setStatus] = useState<ReminderAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ seen: number; changed: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const flip = rowFlipFor(isRTL);

  const load = useCallback(async () => {
    const next = await fetchReminderStatus(payeeId, payeeIsManual);
    setStatus(next);
    setLoading(false);
    return next;
  }, [payeeId, payeeIsManual]);

  useEffect(() => {
    if (!isManager) return;
    let current = true;
    setLoading(true);
    void fetchReminderStatus(payeeId, payeeIsManual).then((next) => {
      if (!current) return;
      setStatus(next);
      setLoading(false);
      setRecipientId(next ? defaultReminderRecipient(next, payeeId) : null);
    });
    return () => {
      current = false;
    };
  }, [isManager, payeeId, payeeIsManual, refreshKey]);

  const state = useMemo(() => (status ? reminderCardState(status, recipientId) : null), [status, recipientId]);

  if (!isManager) return null;
  if (loading && !status) {
    return (
      <View style={[styles.card, style]}>
        <ActivityIndicator size="small" color={theme.colors.cta} />
      </View>
    );
  }
  if (!status || !state) {
    return (
      <View style={[styles.card, style]}>
        <AppText variant="body" muted isRTL={isRTL}>
          {t("paymentReminder.loadFailed")}
        </AppText>
        <ActionButton label={t("paymentReminder.retry")} onPress={() => void load()} />
      </View>
    );
  }
  // Someone who could never receive a reminder and owes nothing has nothing to show here.
  if (!status.is_family && status.balance === 0 && status.members[0]?.ineligible_reason === "not_athlete") return null;

  const recipient = status.members.find((m) => m.id === recipientId) ?? null;
  const pending = state.pending;
  const familyLabel = status.is_family ? `${t("paymentReminder.combinedBalance")} · ` : "";
  const balanceLabel =
    state.balanceTone === "owe"
      ? `${familyLabel}${t("paymentReminder.owes")}`
      : state.balanceTone === "credit"
        ? `${familyLabel}${t("paymentReminder.credit")}`
        : status.is_family
          ? t("paymentReminder.combinedBalance")
          : t("billing.balance");

  async function send() {
    if (!confirm || !recipientId || sending) return;
    setSending(true);
    const res = await sendPaymentReminder(recipientId, confirm.seen);
    setSending(false);
    if (res.ok) {
      setConfirm(null);
      showToast({
        message: t("paymentReminder.sentToast").replace("{name}", recipient?.name ?? ""),
        variant: "success",
      });
    } else if (res.error === "balance_changed" && res.currentAmount != null) {
      setConfirm({ seen: res.currentAmount, changed: true });
    } else {
      setConfirm(null);
      const key =
        res.error === "already_pending"
          ? "paymentReminder.alreadyPendingToast"
          : res.error === "no_debt"
            ? "paymentReminder.noDebtToast"
            : "paymentReminder.sendFailedToast";
      showToast({ message: t(key), variant: "error" });
    }
    await load();
  }

  async function cancel(row: ReminderHistoryRow) {
    if (cancelling) return;
    setCancelling(true);
    const ok = await cancelPaymentReminder(row.id);
    setCancelling(false);
    showToast({
      message: t(ok ? "paymentReminder.cancelledToast" : "paymentReminder.sendFailedToast"),
      variant: ok ? "success" : "error",
    });
    await load();
  }

  const previewAmount = confirm ? displayMoney(confirm.seen) : "";

  return (
    <View style={[styles.card, style]} accessibilityLabel={t("paymentReminder.title")}>
      <View style={[styles.head, flip && styles.rowReverse]}>
        <AppText variant="label" isRTL={isRTL} style={styles.headTitle}>
          {t("paymentReminder.title")}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.headChip}>
          {t("paymentReminder.notDateFiltered")}
        </AppText>
      </View>

      {status.is_family ? (
        <AppText variant="caption" isRTL={isRTL} style={styles.familyBanner}>
          {t("families.reportBanner")
            .replace("{name}", status.family_name ?? "")
            .replace("{n}", String(status.members.length))}
        </AppText>
      ) : null}

      <View
        style={[
          styles.balanceBox,
          state.balanceTone === "owe" && styles.balanceOwe,
          state.balanceTone === "credit" && styles.balanceCredit,
        ]}
      >
        <AppText variant="label" isRTL={isRTL} style={styles.balanceLabel}>
          {balanceLabel}
        </AppText>
        <AppText variant="display" isRTL={isRTL} style={styles.balanceValue}>
          {status.balance == null
            ? t("paymentReminder.balanceUnavailable")
            : status.balance === 0
              ? t("billing.balanceEven")
              : displayMoney(Math.abs(status.balance))}
        </AppText>
      </View>
      <AppText variant="caption" muted isRTL={isRTL}>
        {t("paymentReminder.balanceNote")}
      </AppText>

      {status.is_family && state.showAction ? (
        <View style={styles.recipients} accessibilityRole="radiogroup" accessibilityLabel={t("paymentReminder.chooseRecipient")}>
          <AppText variant="label" soft isRTL={isRTL}>
            {t("paymentReminder.chooseRecipient")}
          </AppText>
          {status.members.map((m) => {
            const selectable = m.ineligible_reason == null && !pending;
            const selected = recipientId === m.id;
            const isPendingRecipient = pending?.recipient_id === m.id;
            return (
              <Pressable
                key={`${m.kind}:${m.id}`}
                disabled={!selectable}
                onPress={() => setRecipientId(m.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !selectable }}
                style={[
                  styles.radio,
                  flip && styles.rowReverse,
                  selected && styles.radioOn,
                  !selectable && !isPendingRecipient && styles.radioOff,
                ]}
              >
                <View style={[styles.dot, selected && styles.dotOn]}>{selected ? <View style={styles.dotInner} /> : null}</View>
                <AppText variant="body" isRTL={isRTL} style={styles.radioName}>
                  {m.name}
                </AppText>
                <AppText variant="caption" muted style={styles.radioMeta}>
                  {m.ineligible_reason === "no_login"
                    ? t("paymentReminder.noLoginTag")
                    : m.ineligible_reason
                      ? t("paymentReminder.notEligibleTag")
                      : isPendingRecipient
                        ? t("paymentReminder.statusPending")
                        : m.own_balance
                          ? `${t("paymentReminder.ownBalance")} ${m.own_balance < 0 ? "−" : ""}${displayMoney(Math.abs(m.own_balance))}`
                          : `${t("paymentReminder.ownBalance")} ${t("billing.balanceEven")}`}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {state.notice ? (
        <AppText variant="caption" isRTL={isRTL} style={styles.notice}>
          {t(NOTICE_KEY[state.notice])}
        </AppText>
      ) : null}

      {pending ? (
        <AppText variant="caption" isRTL={isRTL} style={styles.noticeInfo}>
          {t("paymentReminder.pendingNotice")
            .replace("{name}", pending.recipient_name)
            .replace("{when}", formatWhen(pending.sent_at, language))}
        </AppText>
      ) : null}

      {state.showAction ? (
        <PrimaryButton
          label={t(pending ? "paymentReminder.alreadyPending" : "paymentReminder.send")}
          disabled={!state.canSend}
          onPress={() => status.balance != null && setConfirm({ seen: status.balance, changed: false })}
        />
      ) : null}
      {pending ? (
        <Pressable
          onPress={() => void cancel(pending)}
          disabled={cancelling}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.8 }]}
        >
          <AppText variant="body" style={styles.cancelTxt}>
            {t("paymentReminder.cancel")}
          </AppText>
        </Pressable>
      ) : null}

      {state.eligibleRecipients.length > 0 || status.history.length > 0 ? (
        <View style={styles.history}>
          <AppText variant="label" soft isRTL={isRTL}>
            {t("paymentReminder.history")}
          </AppText>
          {status.history.length === 0 ? (
            <AppText variant="caption" muted isRTL={isRTL}>
              {t("paymentReminder.noHistory")}
            </AppText>
          ) : (
            status.history.map((h) => (
              <View key={h.id} style={styles.historyRow}>
                <View style={[styles.head, flip && styles.rowReverse]}>
                  <AppText variant="body" isRTL={isRTL} style={styles.historyTitle}>
                    {displayMoney(h.amount)} · {h.recipient_name}
                  </AppText>
                  <AppText
                    variant="caption"
                    style={[
                      styles.statusPill,
                      h.status === "pending" && styles.statusPending,
                      h.status === "read" && styles.statusRead,
                      (h.status === "settled" || h.status === "account_changed") && styles.statusClosed,
                    ]}
                  >
                    {t(STATUS_KEY[h.status])}
                  </AppText>
                </View>
                <AppText variant="caption" muted isRTL={isRTL}>
                  {t("paymentReminder.sentAt").replace("{when}", formatWhen(h.sent_at, language))}
                </AppText>
                {h.read_at ? (
                  <AppText variant="caption" muted isRTL={isRTL}>
                    {t("paymentReminder.readAt").replace("{when}", formatWhen(h.read_at, language))}
                  </AppText>
                ) : null}
                {h.closed_at ? (
                  <AppText variant="caption" muted isRTL={isRTL}>
                    {t(h.status === "cancelled" ? "paymentReminder.cancelledAt" : "paymentReminder.closedAt").replace(
                      "{when}",
                      formatWhen(h.closed_at, language)
                    )}
                  </AppText>
                ) : null}
                {h.shown_amount != null && h.shown_amount !== h.amount ? (
                  <AppText variant="caption" muted isRTL={isRTL}>
                    {t("paymentReminder.shownAs").replace("{amount}", displayMoney(h.shown_amount))}
                  </AppText>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      <Modal visible={!!confirm} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setConfirm(null)}>
        <View style={styles.backdrop} accessibilityViewIsModal>
          <View style={styles.dialog}>
            <AppText variant="headline" isRTL={isRTL}>
              {t("paymentReminder.confirmTitle")}
            </AppText>
            {confirm?.changed ? (
              <AppText variant="caption" isRTL={isRTL} style={styles.noticeWarn} accessibilityRole="alert">
                {t("paymentReminder.balanceChanged").replace("{amount}", previewAmount)}
              </AppText>
            ) : null}
            <View style={[styles.kv, flip && styles.rowReverse]}>
              <AppText variant="body" muted>
                {t("paymentReminder.confirmTo")}
              </AppText>
              <AppText variant="body" style={styles.kvValue}>
                {recipient?.name ?? ""}
              </AppText>
            </View>
            <View style={[styles.kv, flip && styles.rowReverse]}>
              <AppText variant="body" muted>
                {t(status.is_family ? "paymentReminder.confirmFamilyAmount" : "paymentReminder.confirmAmount")}
              </AppText>
              <AppText variant="body" style={styles.kvValue}>
                {previewAmount}
              </AppText>
            </View>
            <AppText variant="label" soft isRTL={isRTL}>
              {t("paymentReminder.confirmPreview")}
            </AppText>
            <AppText variant="body" isRTL={isRTL} style={styles.preview}>
              {t(status.is_family ? "paymentReminder.messageFamily" : "paymentReminder.message").replace("{amount}", previewAmount)}
            </AppText>
            <ActionButton label={t("paymentReminder.confirmCancel")} onPress={() => setConfirm(null)} disabled={sending} />
            <PrimaryButton
              label={t("paymentReminder.confirmSend")}
              onPress={() => void send()}
              disabled={sending}
              loading={sending}
              loadingLabel={t("common.loading")}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowReverse: { flexDirection: "row-reverse" },
  headTitle: { color: theme.colors.alertSubject, fontWeight: "800" },
  headChip: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
    fontWeight: "700",
  },
  familyBanner: {
    backgroundColor: theme.colors.infoBg,
    borderWidth: 1,
    borderColor: theme.colors.infoBorder,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.info,
    fontWeight: "700",
    overflow: "hidden",
  },
  balanceBox: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  balanceOwe: { backgroundColor: theme.colors.errorBg, borderColor: theme.colors.errorBorder },
  balanceCredit: { backgroundColor: theme.colors.successBg, borderColor: theme.colors.success },
  balanceLabel: { color: theme.colors.alertSubject, fontWeight: "800" },
  balanceValue: { color: theme.colors.text, fontVariant: ["tabular-nums"] },
  recipients: { gap: 6 },
  radio: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: theme.controls.minTouch,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  radioOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surfaceElevated },
  radioOff: { opacity: 0.6 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: theme.colors.borderInput,
    alignItems: "center",
    justifyContent: "center",
  },
  dotOn: { borderColor: theme.colors.cta },
  dotInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.cta },
  radioName: { flex: 1, minWidth: 0, fontWeight: "700" },
  radioMeta: { flexShrink: 0 },
  notice: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.alertSubject,
    overflow: "hidden",
  },
  noticeInfo: {
    backgroundColor: theme.colors.infoBg,
    borderWidth: 1,
    borderColor: theme.colors.infoBorder,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.info,
    overflow: "hidden",
  },
  noticeWarn: {
    backgroundColor: theme.colors.warningBg,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.warning,
    overflow: "hidden",
  },
  cancelBtn: { alignSelf: "center", minHeight: 40, justifyContent: "center", paddingHorizontal: 12 },
  cancelTxt: { color: theme.colors.error },
  history: { gap: 8, marginTop: 4 },
  historyRow: { borderTopWidth: 1, borderTopColor: theme.colors.borderMuted, paddingTop: 8, gap: 2 },
  historyTitle: { flexShrink: 1, fontWeight: "700" },
  statusPill: {
    borderRadius: theme.radius.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
    fontWeight: "700",
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.textMuted,
  },
  statusPending: { backgroundColor: theme.colors.infoBg, color: theme.colors.info },
  statusRead: { backgroundColor: theme.colors.successBg, color: theme.colors.success },
  statusClosed: { backgroundColor: theme.colors.warningBg, color: theme.colors.warning },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 8, 12, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.md,
  },
  dialog: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 12 },
  kvValue: { flexShrink: 1, fontWeight: "800" },
  preview: {
    backgroundColor: "rgba(59, 130, 246, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(96, 165, 250, 0.28)",
    borderRadius: theme.radius.md,
    padding: 12,
    color: "#dbeafe",
    overflow: "hidden",
  },
});
