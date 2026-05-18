import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, Modal, TextInput, Keyboard } from "react-native";
import { useFocusEffect } from "expo-router";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { isBirthdayToday } from "../lib/birthday";
import { normalizePaymentMethodKey, paymentMethodAttendanceLabel } from "../lib/paymentMethod";
import { fetchSessionBillingPriceIls } from "../lib/sessionSlotPrice";

type RegRow = {
  user_id: string;
  attended: boolean | null;
  charge_no_show?: boolean | null;
  payment_method?: string | null;
  amount_paid?: number | string | null;
  profiles:
    | { full_name: string; username: string; phone?: string | null; date_of_birth?: string | null }
    | { full_name: string; username: string; phone?: string | null; date_of_birth?: string | null }[]
    | null;
};

type ManualRow = {
  manual_participant_id: string;
  attended: boolean | null;
  charge_no_show?: boolean | null;
  payment_method?: string | null;
  amount_paid?: number | string | null;
  manual_participants:
    | { full_name: string; phone: string; date_of_birth?: string | null }
    | { full_name: string; phone: string; date_of_birth?: string | null }[]
    | null;
};

type Row =
  | {
      kind: "registered";
      id: string;
      name: string;
      phone?: string;
      attended: boolean | null;
      chargeNoShow: boolean;
      paymentMethod: string | null;
      amountPaid: number | null;
      userId: string;
      birthdayToday: boolean;
    }
  | {
      kind: "manual";
      id: string;
      name: string;
      phone: string;
      attended: boolean | null;
      chargeNoShow: boolean;
      paymentMethod: string | null;
      amountPaid: number | null;
      manualId: string;
      birthdayToday: boolean;
    };

type AttendanceStatus = "unset" | "arrived" | "absent";

function coerceAmountPaid(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Unpaid = no stored method; Cash/PayBox = green; anything else = yellow */
function paymentDisplayTone(payment: string | null | undefined): "unpaid" | "cash_paybox" | "other" {
  const k = normalizePaymentMethodKey(payment);
  if (k === "(none)") return "unpaid";
  if (k === "cash" || k === "paybox") return "cash_paybox";
  return "other";
}

export type SessionAttendanceStats = {
  registered: number;
  arrived: number;
  absent: number;
  unset: number;
  /** Roster rows with a payment method saved (not “none”). */
  withPaymentMethod: number;
  /** Sum of recorded amounts on the roster (₪). */
  totalPaidIls: number;
  /** Active roster rows marked absent with “charge no-show” enabled. */
  noShowChargedCount: number;
  /** Sum of amount_paid on no-show charged rows (₪). */
  noShowCollectedIls: number;
  /** Sum of billing prices for arrived + charged no-show slots (₪). */
  expectedPaymentsIls: number;
  /** Count of roster slots included in expectedPaymentsIls. */
  expectedPaymentSlots: number;
};

type Props = {
  sessionId: string;
  onChanged?: () => void;
  /** Active roster size (app athletes + quick-add rows) after each load. */
  onParticipantCountChange?: (count: number) => void;
  /** Breakdown of attendance flags for ended-session summaries. */
  onAttendanceStatsChange?: (stats: SessionAttendanceStats) => void;
  /** Increment when registrations change (add/remove) so the list reloads without leaving the screen. */
  refreshNonce?: number;
  /** Manager-only: show remove control */
  onRemoveAthlete?: (userId: string) => void | Promise<void>;
  /** Staff: remove quick-added/manual participant from this session */
  onRemoveManualParticipant?: (manualParticipantId: string) => void | Promise<void>;
  /** Staff: bulk mark everyone as arrived (payment optional — skipped). */
  showMarkAllArrived?: boolean;
};

export function ParticipantAttendanceList({
  sessionId,
  onChanged,
  onParticipantCountChange,
  onAttendanceStatsChange,
  refreshNonce = 0,
  onRemoveAthlete,
  onRemoveManualParticipant,
  showMarkAllArrived = true,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showConfirm } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payFor, setPayFor] = useState<Row | null>(null);
  const [payPhase, setPayPhase] = useState<"method" | "amount">("method");
  const [payChosenMethod, setPayChosenMethod] = useState<string | null>(null);
  const [payAmountDraft, setPayAmountDraft] = useState("");
  const [payMode, setPayMode] = useState<"arrived" | "absent_penalty">("arrived");

  function interpolateParticipantName(template: string, name: string) {
    return template.replace(/\{name\}/g, name);
  }

  function confirmRemoveRegistered(item: Extract<Row, { kind: "registered" }>) {
    if (!onRemoveAthlete) return;
    showConfirm({
      title: t("managerSession.removeParticipantConfirmTitle"),
      message: interpolateParticipantName(t("managerSession.removeParticipantConfirmMessage"), item.name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("managerSession.removeParticipantConfirmRemove"),
      confirmVariant: "danger",
      onConfirm: () => void Promise.resolve(onRemoveAthlete(item.userId)),
    });
  }

  function confirmRemoveManual(item: Extract<Row, { kind: "manual" }>) {
    if (!onRemoveManualParticipant) return;
    showConfirm({
      title: t("managerSession.removeParticipantConfirmTitle"),
      message: interpolateParticipantName(t("managerSession.removeParticipantConfirmMessage"), item.name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("managerSession.removeParticipantConfirmRemove"),
      confirmVariant: "danger",
      onConfirm: () => void Promise.resolve(onRemoveManualParticipant(item.manualId)),
    });
  }

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("session_registrations")
      .select("user_id, attended, charge_no_show, payment_method, amount_paid, profiles(full_name, username, phone, date_of_birth)")
      .eq("session_id", sessionId)
      .eq("status", "active");
    const { data: mData, error: mErr } = await supabase
      .from("session_manual_participants")
      .select("manual_participant_id, attended, charge_no_show, payment_method, amount_paid, manual_participants(full_name, phone, date_of_birth)")
      .eq("session_id", sessionId);

    if (error && mErr) {
      setRows([]);
      setLoading(false);
      onParticipantCountChange?.(0);
      onAttendanceStatsChange?.({
        registered: 0,
        arrived: 0,
        absent: 0,
        unset: 0,
        withPaymentMethod: 0,
        totalPaidIls: 0,
        noShowChargedCount: 0,
        noShowCollectedIls: 0,
        expectedPaymentsIls: 0,
        expectedPaymentSlots: 0,
      });
      return;
    }

    const regRows: Row[] = ((data as unknown as RegRow[]) ?? []).map((r) => {
      const p = r.profiles ? (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles) : null;
      return {
        kind: "registered",
        id: `u:${r.user_id}`,
        userId: r.user_id,
        name: p?.full_name ?? "—",
        phone: (p as any)?.phone ? String((p as any).phone) : "",
        attended: r.attended ?? null,
        chargeNoShow: !!(r as any).charge_no_show,
        paymentMethod: (r as any).payment_method ?? null,
        amountPaid: coerceAmountPaid((r as any).amount_paid),
        birthdayToday: isBirthdayToday(p?.date_of_birth ?? null),
      };
    });

    const manualRows: Row[] = ((mData as unknown as ManualRow[]) ?? []).map((r) => {
      const p = r.manual_participants ? (Array.isArray(r.manual_participants) ? r.manual_participants[0] : r.manual_participants) : null;
      return {
        kind: "manual",
        id: `m:${r.manual_participant_id}`,
        manualId: r.manual_participant_id,
        name: p?.full_name ?? "—",
        phone: p?.phone ?? "",
        attended: r.attended ?? null,
        chargeNoShow: !!(r as any).charge_no_show,
        paymentMethod: (r as any).payment_method ?? null,
        amountPaid: coerceAmountPaid((r as any).amount_paid),
        birthdayToday: isBirthdayToday(p?.date_of_birth ?? null),
      };
    });

    const all = [...regRows, ...manualRows].sort((a, b) => a.name.localeCompare(b.name));
    const arrived = all.filter((r) => r.attended === true).length;
    const absent = all.filter((r) => r.attended === false).length;
    const unset = all.filter((r) => r.attended === null).length;
    let withPaymentMethod = 0;
    let totalPaidIls = 0;
    let noShowChargedCount = 0;
    let noShowCollectedIls = 0;
    let expectedPaymentsIls = 0;
    let expectedPaymentSlots = 0;
    for (const r of all) {
      if (normalizePaymentMethodKey(r.paymentMethod) !== "(none)") withPaymentMethod += 1;
      if (r.amountPaid != null && r.amountPaid > 0) totalPaidIls += r.amountPaid;
      if (r.attended === false && r.chargeNoShow) {
        noShowChargedCount += 1;
        if (r.amountPaid != null && r.amountPaid > 0) noShowCollectedIls += r.amountPaid;
      }
    }
    for (const r of all) {
      const owes = r.attended === true || (r.attended === false && r.chargeNoShow);
      if (!owes) continue;
      expectedPaymentSlots += 1;
      const uid = r.kind === "registered" ? r.userId : null;
      // eslint-disable-next-line no-await-in-loop
      expectedPaymentsIls += await fetchSessionBillingPriceIls(supabase, sessionId, uid);
    }
    setRows(all);
    onParticipantCountChange?.(all.length);
    onAttendanceStatsChange?.({
      registered: all.length,
      arrived,
      absent,
      unset,
      withPaymentMethod,
      totalPaidIls,
      noShowChargedCount,
      noShowCollectedIls,
      expectedPaymentsIls,
      expectedPaymentSlots,
    });
    setLoading(false);
  }, [sessionId, onParticipantCountChange, onAttendanceStatsChange]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    if (refreshNonce > 0) load();
  }, [refreshNonce, load]);

  function formatBillingAmountDraft(amount: number): string {
    const rounded = Math.round(amount * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  }

  async function defaultBillingAmountDraft(row: Row): Promise<string> {
    const uid = row.kind === "registered" ? row.userId : null;
    const price = await fetchSessionBillingPriceIls(supabase, sessionId, uid);
    if (price <= 0) return "";
    return formatBillingAmountDraft(price);
  }

  async function goToPaymentAmountPhase(method: string) {
    setPayChosenMethod(method);
    const row = payFor;
    if (row && payAmountDraft.trim() === "") {
      const draft = await defaultBillingAmountDraft(row);
      if (draft) setPayAmountDraft(draft);
    }
    setPayPhase("amount");
  }

  function openPaymentModal(row: Row, mode: "arrived" | "absent_penalty" = "arrived") {
    setPayMode(mode);
    setPayFor(row);
    setPayPhase("method");
    setPayChosenMethod(null);
    const existing =
      mode === "arrived" && row.attended === true
        ? row.amountPaid
        : mode === "absent_penalty" && row.attended === false && row.chargeNoShow
          ? row.amountPaid
          : null;
    setPayAmountDraft(existing != null ? formatBillingAmountDraft(existing) : "");
    setPayOpen(true);
  }

  function closePaymentModal() {
    Keyboard.dismiss();
    setPayOpen(false);
    setPayFor(null);
    setPayPhase("method");
    setPayChosenMethod(null);
    setPayAmountDraft("");
    setPayMode("arrived");
  }

  function parseOptionalAmountInput(s: string): number | null | "invalid" {
    const t = s.trim().replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100) / 100;
  }

  async function setStatus(
    row: Row,
    status: AttendanceStatus,
    paymentMethod?: string | null,
    amountPaid?: number | null,
    chargeNoShow?: boolean
  ) {
    const key = row.id;
    setBusyKey(key);
    const pCharge =
      status === "absent" ? (chargeNoShow ?? false) : false;
    const { data, error } =
      row.kind === "registered"
        ? await supabase.rpc("set_registration_attendance", {
            p_session_id: sessionId,
            p_user_id: row.userId,
            p_status: status,
            p_payment_method: paymentMethod ?? null,
            p_amount_paid: amountPaid ?? null,
            p_charge_no_show: pCharge,
          })
        : await supabase.rpc("set_manual_participant_attendance", {
            p_session_id: sessionId,
            p_manual_participant_id: row.manualId,
            p_status: status,
            p_payment_method: paymentMethod ?? null,
            p_amount_paid: amountPaid ?? null,
            p_charge_no_show: pCharge,
          });
    setBusyKey(null);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(language === "he" ? "לא ניתן לשמור" : "Could not save", data?.error ?? "");
      return;
    }
    await load();
    onChanged?.();
  }

  async function markAllArrived() {
    if (rows.length === 0) return;
    const todo = rows.filter((r) => r.attended !== true);
    if (todo.length === 0) return;
    const ok =
      language === "he"
        ? `לסמן הגעה לכל המשתתפים (${todo.length}) בלי אמצעי תשלום?`
        : `Mark ${todo.length} participant(s) as arrived without payment method?`;
    Alert.alert(language === "he" ? "סימון המוני" : "Mark all", ok, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: language === "he" ? "אישור" : "OK",
        onPress: () => void runMarkAll(),
      },
    ]);
  }

  async function runMarkAll() {
    setBusyKey("__all__");
    const todo = rows.filter((r) => r.attended !== true);
    try {
      for (const row of todo) {
        const { data, error } =
          row.kind === "registered"
            ? await supabase.rpc("set_registration_attendance", {
                p_session_id: sessionId,
                p_user_id: row.userId,
                p_status: "arrived",
                p_payment_method: null,
                p_amount_paid: null,
                p_charge_no_show: false,
              })
            : await supabase.rpc("set_manual_participant_attendance", {
                p_session_id: sessionId,
                p_manual_participant_id: row.manualId,
                p_status: "arrived",
                p_payment_method: null,
                p_amount_paid: null,
                p_charge_no_show: false,
              });
        if (error) {
          Alert.alert(t("common.error"), error.message);
          return;
        }
        if (!data?.ok) {
          Alert.alert(language === "he" ? "לא ניתן לשמור" : "Could not save", data?.error ?? "");
          return;
        }
      }
      await load();
      onChanged?.();
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return <ActivityIndicator color={theme.colors.cta} style={styles.loader} />;
  }

  if (rows.length === 0) {
    return <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין הרשמות פעילות." : "No active registrations."}</Text>;
  }

  return (
    <View style={styles.list}>
      {showMarkAllArrived && rows.some((r) => r.attended !== true) ? (
        <Pressable
          style={({ pressed }) => [styles.markAll, pressed && { opacity: 0.9 }]}
          onPress={markAllArrived}
          disabled={busyKey !== null}
        >
          <Text style={styles.markAllTxt}>{language === "he" ? "סמן הכל כ”הגיע”" : "Mark all arrived"}</Text>
        </Pressable>
      ) : null}
      {rows.map((item) => {
        const current: AttendanceStatus =
          item.attended === true ? "arrived" : item.attended === false ? "absent" : "unset";
        const busy = busyKey === item.id || busyKey === "__all__";
        return (
          <View key={item.id} style={styles.card}>
            <View style={[styles.nameRow, isRTL && styles.nameRowRtl]}>
              <View style={[styles.nameBlock, isRTL && styles.nameBlockRtl]}>
                <Text style={[styles.name, isRTL && styles.rtlText]} numberOfLines={1}>
                  {item.name}
                  {item.birthdayToday ? <Text style={styles.bday}>{"  "}🎂</Text> : null}
                </Text>
                {item.phone ? (
                  <Text style={[styles.sub, isRTL && styles.rtlText]} numberOfLines={1}>
                    {item.phone}
                  </Text>
                ) : null}
                {item.attended === true ? (
                  <Pressable
                    onPress={() => {
                      if (busy) return;
                      openPaymentModal(item, "arrived");
                    }}
                    disabled={busy}
                    hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                    style={({ pressed }) => [pressed && { opacity: 0.85 }]}
                  >
                    <Text
                      style={[
                        styles.paymentLine,
                        isRTL && styles.rtlText,
                        paymentDisplayTone(item.paymentMethod) === "unpaid" && styles.paymentUnpaid,
                        paymentDisplayTone(item.paymentMethod) === "cash_paybox" && styles.paymentCash,
                        paymentDisplayTone(item.paymentMethod) === "other" && styles.paymentOther,
                      ]}
                      numberOfLines={2}
                    >
                      {language === "he" ? "תשלום: " : "Payment: "}
                      {paymentDisplayTone(item.paymentMethod) === "unpaid"
                        ? language === "he"
                          ? "לא שולם"
                          : "Unpaid"
                        : paymentMethodAttendanceLabel(item.paymentMethod, language)}
                      {item.amountPaid != null
                        ? language === "he"
                          ? ` · ${item.amountPaid} ₪`
                          : ` · ${item.amountPaid}`
                        : ""}
                    </Text>
                  </Pressable>
                ) : item.attended === false && item.chargeNoShow ? (
                  <Pressable
                    onPress={() => {
                      if (busy) return;
                      openPaymentModal(item, "absent_penalty");
                    }}
                    disabled={busy}
                    hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                    style={({ pressed }) => [pressed && { opacity: 0.85 }]}
                  >
                    <Text
                      style={[
                        styles.paymentLine,
                        isRTL && styles.rtlText,
                        paymentDisplayTone(item.paymentMethod) === "unpaid" && styles.paymentUnpaid,
                        paymentDisplayTone(item.paymentMethod) === "cash_paybox" && styles.paymentCash,
                        paymentDisplayTone(item.paymentMethod) === "other" && styles.paymentOther,
                      ]}
                      numberOfLines={2}
                    >
                      {language === "he" ? "תשלום (נעדר): " : "No-show payment: "}
                      {paymentDisplayTone(item.paymentMethod) === "unpaid"
                        ? language === "he"
                          ? "לא שולם"
                          : "Unpaid"
                        : paymentMethodAttendanceLabel(item.paymentMethod, language)}
                      {item.amountPaid != null
                        ? language === "he"
                          ? ` · ${item.amountPaid} ₪`
                          : ` · ${item.amountPaid}`
                        : ""}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={[styles.nameRight, isRTL && styles.nameRightRtl]}>
                {busy ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
                {item.kind === "registered" && onRemoveAthlete && !busy ? (
                  <Pressable
                    onPress={() => confirmRemoveRegistered(item)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t("a11y.removeParticipant")}
                    style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
                  >
                    <Text style={styles.removeIcon} importantForAccessibility="no">
                      {"×"}
                    </Text>
                  </Pressable>
                ) : null}
                {item.kind === "manual" && onRemoveManualParticipant && !busy ? (
                  <Pressable
                    onPress={() => confirmRemoveManual(item)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t("a11y.removeParticipant")}
                    style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
                  >
                    <Text style={styles.removeIcon} importantForAccessibility="no">
                      {"×"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{language === "he" ? "נוכחות" : "Attendance"}</Text>
            <View style={[styles.seg, isRTL && styles.segRtl]}>
              {(["unset", "arrived", "absent"] as const).map((st) => (
                <Pressable
                  key={st}
                  disabled={busy}
                  onPress={() => {
                    if (st === "arrived") {
                      openPaymentModal(item, "arrived");
                      return;
                    }
                    void setStatus(item, st, null, null, st === "absent" ? false : undefined);
                  }}
                  style={({ pressed }) => [
                    styles.segBtn,
                    current === st && styles.segBtnOn,
                    pressed && styles.segBtnPressed,
                  ]}
                >
                  <Text style={[styles.segTxt, current === st && styles.segTxtOn]}>
                    {st === "unset"
                      ? language === "he"
                        ? "לא סומן"
                        : "Not set"
                      : st === "arrived"
                        ? language === "he"
                          ? "הגיע"
                          : "Arrived"
                        : language === "he"
                          ? "נעדר"
                          : "Absent"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {current === "absent" ? (
              <View style={[styles.noShowFeeRow, isRTL && styles.noShowFeeRowRtl]}>
                <Text style={[styles.noShowFeeLabel, isRTL && styles.rtlText]}>
                  {language === "he" ? "חיוב על נעדרות" : "Charge no-show fee"}
                </Text>
                <View style={[styles.noShowFeeSeg, isRTL && styles.noShowFeeSegRtl]}>
                  <Pressable
                    disabled={busy}
                    onPress={() => void setStatus(item, "absent", null, null, false)}
                    style={({ pressed }) => [
                      styles.noShowFeeBtn,
                      !item.chargeNoShow && styles.noShowFeeBtnOn,
                      pressed && styles.segBtnPressed,
                    ]}
                  >
                    <Text style={[styles.noShowFeeBtnTxt, !item.chargeNoShow && styles.noShowFeeBtnTxtOn]}>
                      {language === "he" ? "לא" : "No"}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => void setStatus(item, "absent", null, null, true)}
                    style={({ pressed }) => [
                      styles.noShowFeeBtn,
                      item.chargeNoShow && styles.noShowFeeBtnOn,
                      pressed && styles.segBtnPressed,
                    ]}
                  >
                    <Text style={[styles.noShowFeeBtnTxt, item.chargeNoShow && styles.noShowFeeBtnTxtOn]}>
                      {language === "he" ? "כן" : "Yes"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
      <Modal visible={payOpen} transparent animationType="fade" onRequestClose={closePaymentModal}>
        <View style={styles.payBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closePaymentModal} accessibilityRole="button" />
          <View style={styles.payCard}>
            {payPhase === "method" ? (
              <>
                <Text style={[styles.payTitle, isRTL && styles.rtlText]}>
                  {payMode === "absent_penalty"
                    ? language === "he"
                      ? "תשלום — נעדר"
                      : "Payment — no-show"
                    : language === "he"
                      ? "אופן תשלום"
                      : "Payment method"}
                </Text>
                {(["cash", "PayBox", "other"] as const).map((pm) => (
                  <Pressable
                    key={pm}
                    style={({ pressed }) => [styles.payBtn, pressed && { opacity: 0.9 }]}
                    onPress={() => {
                      const method = pm === "cash" ? "cash" : pm === "PayBox" ? "paybox" : "other";
                      void goToPaymentAmountPhase(method);
                    }}
                  >
                    <Text style={styles.payBtnTxt}>
                      {pm === "cash" ? (language === "he" ? "מזומן" : "Cash") : pm === "PayBox" ? "PayBox" : language === "he" ? "אחר" : "Other"}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={({ pressed }) => [styles.payBtn, styles.payBtnUnpaid, pressed && { opacity: 0.9 }]}
                  onPress={() => {
                    const row = payFor;
                    if (!row) return;
                    closePaymentModal();
                    if (payMode === "absent_penalty") void setStatus(row, "absent", null, null, true);
                    else void setStatus(row, "arrived", null, null);
                  }}
                >
                  <Text style={[styles.payBtnTxt, styles.payBtnTxtUnpaid]}>
                    {language === "he" ? "לא שולם" : "Unpaid"}
                  </Text>
                </Pressable>
                <Pressable onPress={closePaymentModal} style={({ pressed }) => pressed && { opacity: 0.8 }}>
                  <Text style={styles.payCancel}>{t("common.cancel")}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.payTitle, isRTL && styles.rtlText]}>
                  {payMode === "absent_penalty"
                    ? language === "he"
                      ? "סכום ששולם (נעדר)"
                      : "Amount paid (no-show)"
                    : language === "he"
                      ? "סכום ששולם"
                      : "Amount paid"}
                </Text>
                <Text style={[styles.payHint, isRTL && styles.rtlText]}>
                  {language === "he" ? "אופציונלי — השאירו ריק אם לא רלוונטי." : "Optional — leave blank if not needed."}
                </Text>
                <TextInput
                  style={[styles.payAmountInput, isRTL && styles.payAmountInputRtl]}
                  value={payAmountDraft}
                  onChangeText={setPayAmountDraft}
                  placeholder={language === "he" ? "למשל 120" : "e.g. 120"}
                  placeholderTextColor={theme.colors.placeholderOnLight}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                <Pressable
                  style={({ pressed }) => [styles.payBtn, styles.payBtnPrimary, pressed && { opacity: 0.9 }]}
                  onPress={() => {
                    const row = payFor;
                    const method = payChosenMethod;
                    if (!row || !method) return;
                    const parsed = parseOptionalAmountInput(payAmountDraft);
                    if (parsed === "invalid") {
                      Alert.alert(
                        t("common.error"),
                        language === "he" ? "הזינו מספר חיובי או השאירו ריק." : "Enter a valid positive number or leave blank."
                      );
                      return;
                    }
                    closePaymentModal();
                    if (payMode === "absent_penalty") void setStatus(row, "absent", method, parsed, true);
                    else void setStatus(row, "arrived", method, parsed);
                  }}
                >
                  <Text style={styles.payBtnTxtPrimary}>{language === "he" ? "אישור" : "Confirm"}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setPayPhase("method");
                    setPayChosenMethod(null);
                  }}
                  style={({ pressed }) => pressed && { opacity: 0.8 }}
                >
                  <Text style={styles.payCancel}>{language === "he" ? "חזרה" : "Back"}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: theme.spacing.md },
  muted: { color: theme.colors.textMuted, fontStyle: "italic", marginVertical: 8 },
  rtlText: { textAlign: "right" },
  list: { gap: theme.spacing.sm },
  markAll: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignSelf: "flex-start",
  },
  markAllTxt: { color: theme.colors.cta, fontWeight: "900", fontSize: 13 },
  card: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  nameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  nameRowRtl: { flexDirection: "row-reverse" },
  nameBlock: { flex: 1, alignItems: "flex-start", minWidth: 0 },
  nameBlockRtl: { alignItems: "flex-end" },
  name: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.text },
  bday: { color: theme.colors.cta, fontWeight: "900" },
  sub: { marginTop: 2, color: theme.colors.textMuted, fontSize: 12 },
  paymentLine: { marginTop: 6, fontSize: 13, fontWeight: "800" },
  paymentUnpaid: { color: theme.colors.error },
  paymentCash: { color: theme.colors.success },
  paymentOther: { color: "#EAB308" },
  nameRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  nameRightRtl: { flexDirection: "row-reverse" },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: (theme.colors as any).errorBorder ?? theme.colors.borderMuted,
  },
  removeBtnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  removeIcon: { color: theme.colors.error, fontWeight: "900", fontSize: 18, lineHeight: 18 },
  hint: { marginTop: 8, fontSize: 12, color: theme.colors.textMuted, fontWeight: "600" },
  seg: { flexDirection: "row", marginTop: 8, gap: 6, flexWrap: "wrap" },
  segRtl: { flexDirection: "row-reverse" },
  segBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  segBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  segBtnPressed: { opacity: 0.85 },
  segTxt: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  segTxtOn: { color: theme.colors.ctaText },
  noShowFeeRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  noShowFeeRowRtl: { flexDirection: "row-reverse" },
  noShowFeeLabel: { flex: 1, fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  noShowFeeSeg: { flexDirection: "row", gap: 6 },
  noShowFeeSegRtl: { flexDirection: "row-reverse" },
  noShowFeeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minWidth: 52,
    alignItems: "center",
  },
  noShowFeeBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  noShowFeeBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  noShowFeeBtnTxtOn: { color: theme.colors.ctaText },
  payBackdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.45)" },
  payCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    zIndex: 1,
  },
  payTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.text },
  payHint: { marginTop: 6, fontSize: 13, color: theme.colors.textMuted, fontWeight: "600" },
  payAmountInput: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
  },
  payAmountInputRtl: { textAlign: "right" },
  payBtn: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: 10,
  },
  payBtnTxt: { color: theme.colors.text, fontWeight: "800" },
  payBtnPrimary: { marginTop: 12, backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  payBtnTxtPrimary: { color: theme.colors.ctaText, fontWeight: "900", textAlign: "center" },
  payBtnUnpaid: { borderColor: theme.colors.error, backgroundColor: theme.colors.errorBg },
  payBtnTxtUnpaid: { color: theme.colors.error },
  payCancel: { marginTop: 6, textAlign: "center", color: theme.colors.textMuted, fontWeight: "800" },
});
