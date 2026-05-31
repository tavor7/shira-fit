import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, SectionList, TextInput, StyleSheet, Pressable, FlatList, ActivityIndicator, Platform } from "react-native";
import { useLocalSearchParams, usePathname } from "expo-router";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { DatePickerField } from "../components/DatePickerField";
import { AddAccountPaymentModal } from "../components/AddAccountPaymentModal";
import { AppModal } from "../components/AppModal";
import { AppSearchSheet } from "../components/AppSearchSheet";
import { supabase } from "../lib/supabase";
import { formatSessionStartTime, formatSessionTimeRange } from "../lib/sessionTime";
import { toISODateLocal, isValidISODateString, parseISODateLocal, firstDayOfMonthISOLocal } from "../lib/isoDate";
import { formatISODateFull, formatISODateFullWithWeekdayAfter } from "../lib/dateFormat";
import type { AthleteAccountPayment, ParticipantHistoryRow } from "../types/database";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { normalizePaymentMethodKey, paymentMethodHistoryLabel, isSessionPaymentRecorded } from "../lib/paymentMethod";
import { resolveSessionBillingPriceLocal } from "../lib/sessionSlotPrice";
import {
  type AthleteFamily,
  type AthleteFamilyMember,
  memberPayeeKey,
  parseFamilyMembers,
  resolveFamilyMemberByPayee,
} from "../lib/athleteFamilies";
import type { PricingRateTierRow } from "../lib/pricingRates";

type HistorySection = { title: string; data: HistoryListItem[] };
type HistoryListItem =
  | { kind: "session"; reg: ParticipantHistoryRow }
  | { kind: "payment"; pay: AthleteAccountPayment };

function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type AttStatus = "unset" | "arrived" | "absent";

function attStatusFromRow(reg: ParticipantHistoryRow): AttStatus {
  return reg.attended === true ? "arrived" : reg.attended === false ? "absent" : "unset";
}

function attStatusLabel(status: AttStatus, t: (key: string) => string): string {
  if (status === "arrived") return t("participantHistory.attendanceArrived");
  if (status === "absent") return t("participantHistory.attendanceAbsent");
  return t("participantHistory.attendanceNotSet");
}

function attStatusColor(status: AttStatus): string {
  if (status === "arrived") return theme.colors.success;
  if (status === "absent") return theme.colors.error;
  return theme.colors.textSoft;
}

function AttStatusDot({ status }: { status: AttStatus }) {
  return <View style={[styles.statusDot, { backgroundColor: attStatusColor(status) }]} />;
}

type BillingSummary = {
  received: number;
  expected: number;
  missingRuleCount: number;
  byMethod: { key: string; total: number }[];
  balance: number;
};

function computeBillingSummary(
  regs: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  globalTiers: PricingRateTierRow[],
  athleteTiers: PricingRateTierRow[],
  globalKickboxTiers: PricingRateTierRow[],
  sessionCustomById: Record<string, number | null>,
  sessionKickboxById: Record<string, boolean>,
  athleteTiersByMember?: Record<string, PricingRateTierRow[]>,
  memberKeyForRow?: (reg: ParticipantHistoryRow) => string | null
): BillingSummary {
  const methodTotals = new Map<string, number>();

  function addToMethod(rawMethod: string | null | undefined, amount: number) {
    if (amount <= 0) return;
    let k = normalizePaymentMethodKey(rawMethod);
    if (k === "(none)") k = "other";
    methodTotals.set(k, (methodTotals.get(k) ?? 0) + amount);
  }

  let received = 0;
  for (const r of regs) {
    const amt = parseMoney(r.amount_paid);
    if (amt !== null && amt > 0) {
      received += amt;
      addToMethod(r.payment_method, amt);
    }
  }
  for (const p of payments) {
    const amt = parseMoney(p.amount_ils);
    if (amt !== null && amt > 0) {
      received += amt;
      addToMethod(p.payment_method, amt);
    }
  }

  let expected = 0;
  let missingRuleCount = 0;
  for (const r of regs) {
    const cap = typeof r.max_participants === "number" ? r.max_participants : null;
    const lateCancelOwes =
      r.reg_status === "cancelled" &&
      r.cancellation_within_12h === true &&
      r.cancellation_charged === true;
    const owes =
      (r.reg_status === "active" && r.attended === true) ||
      (r.reg_status === "active" && r.attended === false && r.charge_no_show === true) ||
      lateCancelOwes;
    if (!owes || cap === null || cap <= 0) continue;
    const sessionDate = r.session_date;
    const memberKey = memberKeyForRow?.(r) ?? null;
    const rowAthleteTiers =
      memberKey && athleteTiersByMember?.[memberKey] ? athleteTiersByMember[memberKey]! : athleteTiers;
    const price = resolveSessionBillingPriceLocal({
      customSlotPriceIls: sessionCustomById[r.session_id],
      maxParticipants: cap,
      isKickbox: sessionKickboxById[r.session_id] ?? false,
      sessionDate,
      athleteTiers: rowAthleteTiers,
      globalTiers,
      globalKickboxTiers,
    });
    if (price === null) missingRuleCount += 1;
    else expected += price;
  }

  for (const r of regs) {
    const pc = parseMoney(r.cancellation_penalty_collected);
    if (pc != null && pc > 0) {
      received += pc;
      addToMethod("other", pc);
    }
  }

  const byMethod = Array.from(methodTotals.entries())
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);

  return { received, expected, missingRuleCount, byMethod, balance: expected - received };
}

function mergedHistorySections(
  rows: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  athleteLabel: string,
  familyContext?: AthleteFamily | null
): HistorySection[] {
  const title = familyContext
    ? familyContext.name
    : rows.length > 0
      ? `${rows[0]!.athlete_name} · ${rows[0]!.athlete_phone}`
      : athleteLabel.trim() || "—";
  const data: HistoryListItem[] = [
    ...payments.map((pay) => ({ kind: "payment" as const, pay })),
    ...rows.map((reg) => ({ kind: "session" as const, reg })),
  ].sort((a, b) => {
    const da = a.kind === "session" ? a.reg.session_date : a.pay.paid_at;
    const db = b.kind === "session" ? b.reg.session_date : b.pay.paid_at;
    const c = db.localeCompare(da);
    if (c !== 0) return c;
    if (a.kind === "session" && b.kind === "session") {
      return String(b.reg.start_time).localeCompare(String(a.reg.start_time));
    }
    return 0;
  });
  return [{ title, data }];
}

function defaultEndISO() {
  return toISODateLocal(new Date());
}

type Athlete = { user_id: string; full_name: string; username: string; phone: string };
type QuickLinked = { id: string; full_name: string; phone: string; linked_user_id: string | null };
type PickerRow =
  | ({ kind: "athlete" } & Athlete)
  | ({ kind: "quick" } & QuickLinked);

export default function ParticipantHistoryScreen({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const { presetUserId } = useLocalSearchParams<{ presetUserId?: string }>();
  const presetUid =
    typeof presetUserId === "string" ? presetUserId : Array.isArray(presetUserId) ? presetUserId[0] : undefined;
  const { language, t, isRTL } = useI18n();
  /** Web sets `html dir=rtl`; extra row-reverse there mirrors layout twice. */
  const rtlRowFlip = isRTL && Platform.OS !== "web";
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const pathname = usePathname();
  const isCoachHistory = pathname?.startsWith("/coach/participant-history") ?? false;
  /** Dedicated route or Reports hub athlete tab (embedded via ManagerReportsScreen). */
  const isManagerHistory =
    (pathname?.startsWith("/manager/participant-history") ?? false) ||
    (pathname?.startsWith("/manager/reports") ?? false);
  const [start, setStart] = useState(() => firstDayOfMonthISOLocal());
  const [end, setEnd] = useState(defaultEndISO);
  const [athleteId, setAthleteId] = useState<string>("");
  const [athleteLabel, setAthleteLabel] = useState<string>("");
  const [phone, setPhone] = useState(""); // used as RPC filter; set from athlete selection
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [athletes, setAthletes] = useState<PickerRow[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rows, setRows] = useState<ParticipantHistoryRow[]>([]);
  const [accountPayments, setAccountPayments] = useState<AthleteAccountPayment[]>([]);
  const [globalTiers, setGlobalTiers] = useState<PricingRateTierRow[]>([]);
  const [athleteTiers, setAthleteTiers] = useState<PricingRateTierRow[]>([]);
  const [globalKickboxTiers, setGlobalKickboxTiers] = useState<PricingRateTierRow[]>([]);
  const [sessionCustomPriceById, setSessionCustomPriceById] = useState<Record<string, number | null>>({});
  const [sessionKickboxById, setSessionKickboxById] = useState<Record<string, boolean>>({});
  const [sessionCoachById, setSessionCoachById] = useState<Record<string, string>>({});
  const [payeeIsManual, setPayeeIsManual] = useState(false);
  const [familyContext, setFamilyContext] = useState<AthleteFamily | null>(null);
  const [athleteTiersByMember, setAthleteTiersByMember] = useState<Record<string, PricingRateTierRow[]>>({});
  const [addPayOpen, setAddPayOpen] = useState(false);
  const [editAccountPayment, setEditAccountPayment] = useState<AthleteAccountPayment | null>(null);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  /** True after a successful Load for the current athlete/date range (hides billing card on fetch error). */
  const [reportReady, setReportReady] = useState(false);
  const [emptyHint, setEmptyHint] = useState<string>(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");
  const [editAmountOpen, setEditAmountOpen] = useState(false);
  const [editAmountBusy, setEditAmountBusy] = useState(false);
  const [editAmountStr, setEditAmountStr] = useState("");
  const [editMethod, setEditMethod] = useState<"cash" | "paybox" | "other" | "">("");
  const [editReg, setEditReg] = useState<ParticipantHistoryRow | null>(null);
  const [policyBusyId, setPolicyBusyId] = useState<string | null>(null);
  const [removingRegId, setRemovingRegId] = useState<string | null>(null);
  const [attendanceBusyId, setAttendanceBusyId] = useState<string | null>(null);
  const [expandedAttendanceId, setExpandedAttendanceId] = useState<string | null>(null);

  function memberForRow(reg: ParticipantHistoryRow): AthleteFamilyMember | null {
    if (!familyContext) return null;
    return familyContext.members.find((m) => m.id === reg.athlete_user_id) ?? null;
  }

  function memberKeyForRow(reg: ParticipantHistoryRow): string | null {
    const m = memberForRow(reg);
    if (m) return memberPayeeKey(m.kind, m.id);
    if (familyContext) return memberPayeeKey(payeeIsManual ? "manual" : "app", reg.athlete_user_id);
    return null;
  }

  function isManualHistoryRow(reg: ParticipantHistoryRow): boolean {
    const m = memberForRow(reg);
    if (m) return m.kind === "manual";
    return payeeIsManual || reg.athlete_user_id !== athleteId;
  }

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  function confirmDeleteAccountPayment(paymentId: string) {
    showConfirm({
      title: language === "he" ? "אישור" : "Confirm",
      message: t("billing.deletePaymentConfirm"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("billing.deletePayment"),
      confirmVariant: "danger",
      onConfirm: () => {
        void (async () => {
          setDeletingPaymentId(paymentId);
          const { error } = await supabase.from("athlete_account_payments").delete().eq("id", paymentId);
          setDeletingPaymentId(null);
          if (error) {
            showError(error.message);
            return;
          }
          showToast({ message: t("billing.paymentDeleted"), variant: "success" });
          await load({ silent: true });
        })();
      },
    });
  }

  async function applyLateCancellationCharge(cancellationId: string, charge: boolean) {
    if (policyBusyId) return;
    setPolicyBusyId(`lc:${cancellationId}`);
    try {
      const { data, error } = await supabase.rpc("manager_set_cancellation_charge", {
        p_cancellation_id: cancellationId,
        p_charge: charge,
      });
      if (error) {
        showError(error.message);
        return;
      }
      if (data?.ok !== true) {
        const code = String(data?.error ?? "failed");
        showError(code === "not_late_cancellation" ? t("managerSession.notLateCancellationError") : code);
        return;
      }
      await load({ silent: true });
    } finally {
      setPolicyBusyId(null);
    }
  }

  async function applyNoShowCharge(reg: ParticipantHistoryRow, charge: boolean) {
    const key = `ns:${reg.registration_id}`;
    if (policyBusyId) return;
    setPolicyBusyId(key);
    try {
      const isManualRow = isManualHistoryRow(reg);
      const res = isManualRow
        ? await supabase.rpc("set_manual_participant_attendance", {
            p_session_id: reg.session_id,
            p_manual_participant_id: reg.athlete_user_id,
            p_status: "absent",
            p_payment_method: null,
            p_amount_paid: null,
            p_charge_no_show: charge,
          })
        : await supabase.rpc("set_registration_attendance", {
            p_session_id: reg.session_id,
            p_user_id: reg.athlete_user_id,
            p_status: "absent",
            p_payment_method: null,
            p_amount_paid: null,
            p_charge_no_show: charge,
          });
      if (res.error) {
        showError(res.error.message);
        return;
      }
      if (res.data?.ok !== true) {
        showError(String(res.data?.error ?? "failed"));
        return;
      }
      await load({ silent: true });
    } finally {
      setPolicyBusyId(null);
    }
  }

  async function applyAttendance(reg: ParticipantHistoryRow, status: "unset" | "arrived" | "absent") {
    const key = `att:${reg.registration_id}`;
    if (attendanceBusyId) return;
    const current =
      reg.attended === true ? "arrived" : reg.attended === false ? "absent" : "unset";
    if (current === status) return;

    setAttendanceBusyId(key);
    try {
      const isManualRow = isManualHistoryRow(reg);
      const chargeNoShow = status === "absent" && reg.charge_no_show === true;
      const hasPay = isSessionPaymentRecorded(reg.payment_method);
      const method =
        status === "arrived" && hasPay
          ? normalizePaymentMethodKey(reg.payment_method) === "(none)"
            ? null
            : reg.payment_method
          : status === "absent" && chargeNoShow && hasPay
            ? reg.payment_method
            : null;
      const amtRaw = method != null ? parseMoney(reg.amount_paid) : null;
      const amountPaid = amtRaw !== null && amtRaw >= 0 ? amtRaw : null;

      const res = isManualRow
        ? await supabase.rpc("set_manual_participant_attendance", {
            p_session_id: reg.session_id,
            p_manual_participant_id: reg.athlete_user_id,
            p_status: status,
            p_payment_method: method,
            p_amount_paid: amountPaid,
            p_charge_no_show: chargeNoShow,
          })
        : await supabase.rpc("set_registration_attendance", {
            p_session_id: reg.session_id,
            p_user_id: reg.athlete_user_id,
            p_status: status,
            p_payment_method: method,
            p_amount_paid: amountPaid,
            p_charge_no_show: chargeNoShow,
          });
      if (res.error) {
        showError(res.error.message);
        return;
      }
      if (res.data?.ok !== true) {
        showError(String(res.data?.error ?? "failed"));
        return;
      }
      await load({ silent: true });
      setExpandedAttendanceId(null);
    } finally {
      setAttendanceBusyId(null);
    }
  }

  function openEditAmount(reg: ParticipantHistoryRow) {
    setEditReg(reg);
    const raw = reg.amount_paid;
    const s = raw !== null && raw !== undefined && String(raw).trim() !== "" ? String(raw) : "";
    setEditAmountStr(s);
    const k = normalizePaymentMethodKey(reg.payment_method);
    setEditMethod(k === "cash" || k === "paybox" || k === "other" ? k : "");
    setEditAmountOpen(true);
  }

  async function saveEditAmount() {
    if (!editReg) return;
    if (!athleteId) return;
    const method = editMethod.length > 0 ? editMethod : null;
    const amtTrim = editAmountStr.replace(",", ".").trim();
    const amt = amtTrim.length === 0 ? null : Number.parseFloat(amtTrim);
    if (amt !== null && (!Number.isFinite(amt) || amt < 0)) {
      showError(language === "he" ? "הזינו סכום תקין (≥ 0)." : "Enter a valid amount (≥ 0).");
      return;
    }
    if (method === null && amt !== null) {
      showError(language === "he" ? "כדי להזין סכום, בחרו אמצעי תשלום." : "Choose a payment method to set an amount.");
      return;
    }

    // Preserve current attendance + payment method; only allowed when attended=true.
    const status = "arrived";

    setEditAmountBusy(true);
    const isManualRow = isManualHistoryRow(editReg);
    const res = isManualRow
      ? await supabase.rpc("set_manual_participant_attendance", {
          p_session_id: editReg.session_id,
          p_manual_participant_id: editReg.athlete_user_id,
          p_status: status,
          p_payment_method: method,
          p_amount_paid: amt,
          p_charge_no_show: false,
        })
      : await supabase.rpc("set_registration_attendance", {
          p_session_id: editReg.session_id,
          p_user_id: editReg.athlete_user_id,
          p_status: status,
          p_payment_method: method,
          p_amount_paid: amt,
          p_charge_no_show: false,
        });
    setEditAmountBusy(false);

    if (res.error) {
      showError(res.error.message);
      return;
    }
    if (res.data?.ok !== true) {
      showError(String(res.data?.error ?? "failed"));
      return;
    }
    setEditAmountOpen(false);
    setEditReg(null);
    await load({ silent: true });
  }

  function confirmRemoveRegistration(reg: ParticipantHistoryRow) {
    const name = (reg.athlete_name || athleteLabel).trim() || (language === "he" ? "המתאמן" : "this athlete");
    const when = `${formatISODateFull(reg.session_date, language)} · ${formatSessionTimeRange(reg.start_time, reg.duration_minutes ?? 60)}`;
    showConfirm({
      title: t("participantHistory.removeRegistrationTitle"),
      message: t("participantHistory.removeRegistrationMessage").replace("{name}", name).replace("{when}", when),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("participantHistory.removeRegistration"),
      confirmVariant: "danger",
      onConfirm: () => void removeRegistration(reg),
    });
  }

  async function removeRegistration(reg: ParticipantHistoryRow) {
    if (!athleteId || removingRegId) return;
    setRemovingRegId(reg.registration_id);
    try {
      const isManualRow = isManualHistoryRow(reg);
      const res = isManualRow
        ? await supabase.rpc("remove_manual_participant_from_session", {
            p_session_id: reg.session_id,
            p_manual_participant_id: reg.athlete_user_id,
          })
        : await supabase.rpc(isManagerHistory ? "manager_remove_athlete" : "coach_remove_athlete", {
            p_session_id: reg.session_id,
            p_user_id: reg.athlete_user_id,
          });
      if (res.error) {
        showError(res.error.message);
        return;
      }
      if (res.data?.ok !== true) {
        showError(String(res.data?.error ?? "failed"));
        return;
      }
      showToast({ message: t("participantHistory.registrationRemoved"), variant: "success" });
      await load({ silent: true });
    } finally {
      setRemovingRegId(null);
    }
  }

  const sections = useMemo(() => {
    if (!hasSearched) return [];
    return mergedHistorySections(rows, accountPayments, athleteLabel, familyContext);
  }, [hasSearched, rows, accountPayments, athleteLabel, familyContext]);

  const billingSummary = useMemo(() => {
    if (!hasSearched || !athleteId) return null;
    return computeBillingSummary(
      rows,
      accountPayments,
      globalTiers,
      athleteTiers,
      globalKickboxTiers,
      sessionCustomPriceById,
      sessionKickboxById,
      familyContext ? athleteTiersByMember : undefined,
      familyContext ? memberKeyForRow : undefined
    );
  }, [
    hasSearched,
    athleteId,
    rows,
    accountPayments,
    globalTiers,
    athleteTiers,
    athleteTiersByMember,
    familyContext,
    globalKickboxTiers,
    sessionCustomPriceById,
    sessionKickboxById,
    payeeIsManual,
  ]);

  useEffect(() => {
    if (!athleteId) {
      setFamilyContext(null);
      return;
    }
    void (async () => {
      const { data, error } = await supabase.rpc("get_athlete_family", {
        p_payee_id: athleteId,
        p_payee_is_manual: payeeIsManual,
      });
      if (error) {
        setFamilyContext(null);
        return;
      }
      const payload = data as {
        ok?: boolean;
        family?: { id: string; name: string; members?: unknown[] } | null;
      };
      if (!payload?.ok || !payload.family) {
        setFamilyContext(null);
        return;
      }
      setFamilyContext({
        id: payload.family.id,
        name: payload.family.name,
        members: parseFamilyMembers(payload.family.members),
      });
    })();
  }, [athleteId, payeeIsManual]);

  useEffect(() => {
    const uid = presetUid;
    if (!uid) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, username, phone")
        .eq("user_id", uid)
        .maybeSingle();
      if (error || !data) return;
      setAthleteId(uid);
      setPayeeIsManual(false);
      setAthleteLabel(`${data.full_name} (@${data.username ?? ""}) · ${data.phone ?? ""}`);
      setPhone((data.phone ?? "").trim());
    })();
  }, [presetUid]);

  const loadAthletes = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;

    let mQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      mQuery = mQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data: mData, error: mErr } = await mQuery;

    setAthletesLoading(false);
    if (error) {
      setAthletes([]);
      return;
    }
    const base = ((data as Athlete[]) ?? []).map((a) => ({ kind: "athlete" as const, ...a }));
    const quick = mErr ? [] : (((mData as QuickLinked[]) ?? []).map((m) => ({ kind: "quick" as const, ...m })));

    const seen = new Set<string>(base.map((b) => b.user_id));
    // Dedup linked quick entries that already appear in the athlete list.
    // Unlinked quick adds (linked_user_id = null) should always show.
    const quickDedup = quick.filter((m) => (m.linked_user_id ? !seen.has(m.linked_user_id) : true));
    setAthletes([...quickDedup, ...base]);
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e)) {
      showError(language === "he" ? "בחרו תאריכי התחלה וסיום תקינים." : "Please choose valid start and end dates.");
      return;
    }
    if (s > e) {
      showError(language === "he" ? "תאריך ההתחלה חייב להיות לפני או שווה לתאריך הסיום." : "Start date must be on or before end date.");
      return;
    }
    if (!athleteId) {
      showError(language === "he" ? "בחרו מתאמן קודם." : "Choose an athlete first.");
      return;
    }
    if (!silent) {
      setLoading(true);
      setReportReady(false);
    }
    const phoneArg = phone.trim().length > 0 ? phone.trim() : null;
    const familyId = familyContext?.id ?? null;
    const familyMembers = familyContext?.members ?? [];

    const histPromise = supabase.rpc("participant_registration_history", {
      p_start: s,
      p_end: e,
      p_phone_search: phoneArg,
      p_athlete_key: familyId ? null : athleteId,
      p_family_id: familyId,
    });

    const pricePromise = supabase
      .from("session_capacity_pricing")
      .select("max_participants, price_ils, is_kickbox, effective_from, effective_to");

    let acctPromise;
    if (familyId && familyMembers.length > 0) {
      const orParts = familyMembers.map(
        (m) => `and(payee_id.eq.${m.id},payee_is_manual.eq.${m.kind === "manual"})`
      );
      acctPromise = supabase
        .from("athlete_account_payments")
        .select("id, payee_id, payee_is_manual, amount_ils, payment_method, note, payer_name, paid_at, created_at, created_by")
        .gte("paid_at", s)
        .lte("paid_at", e)
        .or(orParts.join(","))
        .order("paid_at", { ascending: false });
    } else {
      acctPromise = supabase
        .from("athlete_account_payments")
        .select("id, payee_id, payee_is_manual, amount_ils, payment_method, note, payer_name, paid_at, created_at, created_by")
        .gte("paid_at", s)
        .lte("paid_at", e)
        .eq("payee_id", athleteId)
        .eq("payee_is_manual", payeeIsManual)
        .order("paid_at", { ascending: false });
    }

    const ovPromise =
      familyId && familyMembers.length > 0
        ? Promise.all(
            familyMembers.map(async (m) => {
              const res =
                m.kind === "manual"
                  ? await supabase
                      .from("athlete_session_capacity_pricing")
                      .select("max_participants, price_ils, effective_from, effective_to")
                      .eq("manual_participant_id", m.id)
                  : await supabase
                      .from("athlete_session_capacity_pricing")
                      .select("max_participants, price_ils, effective_from, effective_to")
                      .eq("user_id", m.id);
              return { key: memberPayeeKey(m.kind, m.id), error: res.error, data: res.data };
            })
          )
        : payeeIsManual
          ? supabase
              .from("athlete_session_capacity_pricing")
              .select("max_participants, price_ils, effective_from, effective_to")
              .eq("manual_participant_id", athleteId)
          : supabase
              .from("athlete_session_capacity_pricing")
              .select("max_participants, price_ils, effective_from, effective_to")
              .eq("user_id", athleteId);

    const [histRes, priceRes, acctRes, ovRes] = await Promise.all([
      histPromise,
      pricePromise,
      acctPromise,
      ovPromise,
    ]);

    if (histRes.error) {
      if (!silent) {
        setLoading(false);
        setRows([]);
        setAccountPayments([]);
        setReportReady(false);
        setHasSearched(true);
      }
      showError(histRes.error.message);
      return;
    }
    if (priceRes.error) {
      if (!silent) {
        setLoading(false);
        setRows([]);
        setAccountPayments([]);
        setReportReady(false);
        setHasSearched(true);
      }
      showError(priceRes.error.message);
      return;
    }
    if (acctRes.error) {
      if (!silent) {
        setLoading(false);
        setRows([]);
        setAccountPayments([]);
        setReportReady(false);
        setHasSearched(true);
      }
      showError(acctRes.error.message);
      return;
    }

    const tierRowMap: Record<string, PricingRateTierRow[]> = {};
    let athTiers: PricingRateTierRow[] = [];
    if (familyId && Array.isArray(ovRes)) {
      for (const chunk of ovRes) {
        if (chunk.error) {
          if (!silent) {
            setLoading(false);
            setRows([]);
            setAccountPayments([]);
            setReportReady(false);
            setHasSearched(true);
          }
          showError(chunk.error.message);
          return;
        }
        tierRowMap[chunk.key] = (
          (chunk.data as {
            max_participants: number;
            price_ils: number | string;
            effective_from: string;
            effective_to?: string | null;
          }[]) ?? []
        ).map((o) => ({
          max_participants: Number(o.max_participants),
          price_ils: o.price_ils,
          effective_from: o.effective_from,
          effective_to: o.effective_to,
        }));
      }
      const pickerKey = memberPayeeKey(payeeIsManual ? "manual" : "app", athleteId);
      athTiers = tierRowMap[pickerKey] ?? [];
    } else {
      const singleOv = ovRes as { error?: { message: string } | null; data?: unknown };
      if (singleOv.error) {
        if (!silent) {
          setLoading(false);
          setRows([]);
          setAccountPayments([]);
          setReportReady(false);
          setHasSearched(true);
        }
        showError(singleOv.error.message);
        return;
      }
      athTiers = (
        (singleOv.data as {
          max_participants: number;
          price_ils: number | string;
          effective_from: string;
          effective_to?: string | null;
        }[]) ?? []
      ).map((o) => ({
        max_participants: Number(o.max_participants),
        price_ils: o.price_ils,
        effective_from: o.effective_from,
        effective_to: o.effective_to,
      }));
    }

    const next = (histRes.data as ParticipantHistoryRow[]) ?? [];
    setRows(next);
    const payRows = (acctRes.data as AthleteAccountPayment[]) ?? [];
    const staffIds = [...new Set(payRows.map((p) => p.created_by).filter((id): id is string => !!id))];
    let nameByStaff: Record<string, string> = {};
    if (staffIds.length > 0) {
      const { data: staffProfiles } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", staffIds);
      nameByStaff = Object.fromEntries(
        (staffProfiles ?? []).map((p) => [p.user_id, (p.full_name ?? "").trim()])
      );
    }
    setAccountPayments(
      payRows.map((p) => ({
        ...p,
        created_by_name: p.created_by ? nameByStaff[p.created_by] ?? null : null,
      }))
    );
    const stdTiers: PricingRateTierRow[] = [];
    const kickTiers: PricingRateTierRow[] = [];
    for (const r of (priceRes.data as {
      max_participants: number;
      price_ils: number | string;
      is_kickbox?: boolean;
      effective_from: string;
      effective_to?: string | null;
    }[]) ?? []) {
      const tier: PricingRateTierRow = {
        max_participants: Number(r.max_participants),
        price_ils: r.price_ils,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
      };
      if (r.is_kickbox) kickTiers.push(tier);
      else stdTiers.push(tier);
    }
    setGlobalTiers(stdTiers);
    setGlobalKickboxTiers(kickTiers);
    setAthleteTiers(athTiers);
    setAthleteTiersByMember(tierRowMap);

    const sessionIds = [...new Set(next.map((r) => r.session_id).filter(Boolean))];
    if (sessionIds.length > 0) {
      const { data: sessRows } = await supabase
        .from("training_sessions")
        .select("id, custom_slot_price_ils, is_kickbox, trainer:profiles!coach_id(full_name)")
        .in("id", sessionIds);
      const customMap: Record<string, number | null> = {};
      const kickboxMap: Record<string, boolean> = {};
      const coachMap: Record<string, string> = {};
      for (const sid of sessionIds) {
        customMap[sid] = null;
        kickboxMap[sid] = false;
        coachMap[sid] = "";
      }
      for (const row of (sessRows as {
        id: string;
        custom_slot_price_ils?: number | null;
        is_kickbox?: boolean;
        trainer?: { full_name: string } | { full_name: string }[] | null;
      }[]) ?? []) {
        const raw = row.custom_slot_price_ils;
        customMap[row.id] = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
        kickboxMap[row.id] = !!row.is_kickbox;
        const tr = row.trainer ? (Array.isArray(row.trainer) ? row.trainer[0] : row.trainer) : null;
        coachMap[row.id] = (tr?.full_name ?? "").trim();
      }
      setSessionCustomPriceById(customMap);
      setSessionKickboxById(kickboxMap);
      setSessionCoachById(coachMap);
    } else {
      setSessionCustomPriceById({});
      setSessionKickboxById({});
      setSessionCoachById({});
    }

    if (next.length === 0 && ((acctRes.data as unknown[]) ?? []).length === 0) {
      setEmptyHint(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");
    }

    if (!silent) setLoading(false);
    setReportReady(true);
    setHasSearched(true);
  }, [start, end, phone, athleteId, payeeIsManual, familyContext, language]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!athleteId) return;
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e) || s > e) return;
    void loadRef.current();
  }, [athleteId, start, end, payeeIsManual, familyContext?.id]);

  return (
    <View style={styles.screen}>
      <AppSearchSheet
        visible={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerQ("");
        }}
        title={language === "he" ? "מתאמנים" : "Athletes"}
        dismissLabel={language === "he" ? t("common.ok") : "Done"}
        isRTL={isRTL}
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        searchConfig={{
          value: pickerQ,
          onChangeText: setPickerQ,
          onSearch: (term) => void loadAthletes(term),
          placeholder: language === "he" ? "חיפוש שם / משתמש / טלפון…" : "Search name / username / phone…",
          loading: athletesLoading,
        }}
        data={athletes}
        keyExtractor={(item) => (item.kind === "athlete" ? item.user_id : `quick:${item.id}`)}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
            onPress={() => {
              if (item.kind === "athlete") {
                setAthleteId(item.user_id);
                setPayeeIsManual(false);
                setAthleteLabel(`${item.full_name} (@${item.username}) · ${item.phone}`);
                setPhone(item.phone);
              } else {
                setAthleteId(item.linked_user_id ?? item.id);
                setPayeeIsManual(!item.linked_user_id);
                setAthleteLabel(
                  `${item.full_name} · ${item.phone} · ${
                    item.linked_user_id
                      ? language === "he"
                        ? "קישור מרשימת מהיר"
                        : "Quick Add link"
                      : language === "he"
                        ? "ללא חשבון"
                        : "No account"
                  }`
                );
                setPhone(item.phone);
              }
              setPickerOpen(false);
            }}
          >
            <Text style={styles.pickerItemName}>{item.full_name}</Text>
            <Text style={styles.pickerItemRole}>
              {item.kind === "athlete" ? `@${item.username} · ${item.phone}` : `${item.phone} · ${language === "he" ? "מהיר" : "Quick Add"}`}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.pickerEmpty, isRTL && styles.rtlText]}>{language === "he" ? "אין מתאמנים" : "No athletes"}</Text>
        }
      />

      <AddAccountPaymentModal
        visible={addPayOpen}
        onClose={() => {
          setAddPayOpen(false);
          setEditAccountPayment(null);
        }}
        payeeId={editAccountPayment?.payee_id ?? athleteId}
        payeeIsManual={editAccountPayment?.payee_is_manual ?? payeeIsManual}
        payeeLabel={
          editAccountPayment
            ? resolveFamilyMemberByPayee(
                familyContext,
                editAccountPayment.payee_id ?? athleteId,
                editAccountPayment.payee_is_manual ?? payeeIsManual
              )?.name?.trim() ||
              athleteLabel
            : athleteLabel
        }
        editPayment={editAccountPayment}
        showPayerName={!!familyContext}
        onSaved={() => load({ silent: true })}
      />

      <AppModal
        visible={editAmountOpen}
        onClose={() => {
          if (editAmountBusy) return;
          setEditAmountOpen(false);
          setEditReg(null);
        }}
        variant="sheet"
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        cardStyle={styles.modalBox}
      >
        <View style={styles.modalHeader}>
          <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>
            {language === "he" ? "עדכון סכום לאימון" : "Edit session amount"}
          </Text>
          <Pressable
            onPress={() => {
              if (editAmountBusy) return;
              setEditAmountOpen(false);
              setEditReg(null);
            }}
          >
            <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
          </Pressable>
        </View>
        <View style={styles.addPayBody}>
          {editReg ? (
            <>
              <Text style={[styles.hint, isRTL && styles.rtlText]}>
                {formatISODateFull(editReg.session_date, language)} ·{" "}
                {formatSessionTimeRange(editReg.start_time, editReg.duration_minutes ?? 60)}
              </Text>
            </>
          ) : null}
          <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "אמצעי תשלום" : "Payment method"}</Text>
          <View style={styles.methodRow}>
            {(["", "cash", "paybox", "other"] as const).map((m) => {
              const on = editMethod === m;
              const label = m === "" ? (language === "he" ? "ללא" : "None") : paymentMethodHistoryLabel(m, language);
              return (
                <Pressable
                  key={`editm:${m}`}
                  onPress={() => setEditMethod(m)}
                  disabled={editAmountBusy}
                  style={({ pressed }) => [
                    styles.methodChip,
                    on && styles.methodChipOn,
                    pressed && !on && { opacity: 0.9 },
                    editAmountBusy && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.methodChipTxt, on && styles.methodChipTxtOn]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "סכום ששולם (₪)" : "Amount paid (₪)"}</Text>
          <TextInput
            value={editAmountStr}
            onChangeText={setEditAmountStr}
            keyboardType="decimal-pad"
            placeholder={language === "he" ? "למשל 90" : "e.g. 90"}
            placeholderTextColor={theme.colors.placeholderOnLight}
            style={styles.inputLight}
            editable={!editAmountBusy && editMethod !== ""}
          />
          <PrimaryButton
            label={t("common.save")}
            onPress={() => void saveEditAmount()}
            loading={editAmountBusy}
            loadingLabel={t("common.loading")}
          />
        </View>
      </AppModal>

      <SectionList
        style={styles.list}
        sections={sections}
        keyExtractor={(item) => (item.kind === "session" ? item.reg.registration_id : `pay:${item.pay.id}`)}
        ListHeaderComponent={
          <>
            <View style={styles.filters}>
              {!hideTitle ? (
                <Text style={[styles.screenTitle, isRTL && styles.rtlText]}>
                  {t(isCoachHistory ? "menu.coachHistory" : "menu.athleteActivity")}
                </Text>
              ) : null}
              <DatePickerField label={t("common.from")} value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
              <DatePickerField label={t("common.to")} value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
              <Text style={[styles.label, isRTL && styles.rtlText]}>
                {language === "he" ? "מתאמן (חיפוש לפי שם, משתמש או טלפון)" : "Athlete (search by name, username, or phone)"}
              </Text>
              <Pressable style={styles.pickerTouch} onPress={() => { setPickerQ(""); setPickerOpen(true); }}>
                <Text style={athleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
                  {athleteLabel || (language === "he" ? "בחרו מתאמן…" : "Choose an athlete…")}
                </Text>
              </Pressable>
              {athleteId ? (
                <Pressable
                  style={({ pressed }) => [styles.clearSel, pressed && { opacity: 0.9 }]}
                  onPress={() => {
                    setAthleteId("");
                    setAthleteLabel("");
                    setPhone("");
                    setPayeeIsManual(false);
                    setFamilyContext(null);
                    setAthleteTiersByMember({});
                    setRows([]);
                    setAccountPayments([]);
                    setReportReady(false);
                    setHasSearched(false);
                  }}
                >
                  <Text style={styles.clearSelTxt}>{t("common.clearSelection")}</Text>
                </Pressable>
              ) : null}
            </View>

            {familyContext && athleteId ? (
              <View style={styles.familyBanner}>
                <Text style={[styles.familyBannerTxt, isRTL && styles.rtlText]}>
                  {t("families.reportBanner")
                    .replace("{name}", familyContext.name)
                    .replace("{n}", String(familyContext.members.length))}
                </Text>
                <Text style={[styles.familyMembersLabel, isRTL && styles.rtlText]}>
                  {t("families.reportMembers")}
                </Text>
                {familyContext.members.map((m) => {
                  const phone = (m.phone ?? "").trim();
                  return (
                    <View
                      key={memberPayeeKey(m.kind, m.id)}
                      style={[styles.familyMemberRow, rtlRowFlip && styles.familyMemberRowRtl]}
                    >
                      <Text style={[styles.familyMemberName, isRTL && styles.rtlText]} numberOfLines={1}>
                        {m.name?.trim() || "—"}
                        {m.kind === "manual" ? ` · ${language === "he" ? "מהיר" : "Quick Add"}` : ""}
                      </Text>
                      <Text
                        style={[styles.familyMemberPhone, isRTL ? styles.ltrText : undefined]}
                        numberOfLines={1}
                      >
                        {phone || "—"}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {athleteId && loading ? (
              <View style={styles.loadingBanner}>
                <ActivityIndicator size="small" color={theme.colors.cta} />
                <Text style={styles.loadingBannerTxt}>{t("common.loading")}</Text>
              </View>
            ) : null}

            {billingSummary && athleteId && reportReady ? (
              <View style={styles.billingCard}>
                <Text style={[styles.billingTitle, isRTL && styles.rtlText]}>{t("billing.summaryTitle")}</Text>
                <View style={[styles.billingStatGrid, rtlRowFlip && styles.billingStatGridRtl]}>
                  <View style={styles.billingStatTile}>
                    <Text style={[styles.billingStatLabel, isRTL && styles.rtlText]}>{t("billing.received")}</Text>
                    <Text style={[styles.billingStatValue, isRTL && styles.rtlText]}>
                      {`${Math.round(billingSummary.received * 100) / 100} ₪`}
                    </Text>
                  </View>
                  <View style={styles.billingStatTile}>
                    <Text style={[styles.billingStatLabel, isRTL && styles.rtlText]}>{t("billing.expected")}</Text>
                    <Text style={[styles.billingStatValue, isRTL && styles.rtlText]}>
                      {`${Math.round(billingSummary.expected * 100) / 100} ₪`}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.billingStatTile,
                      billingSummary.balance > 0
                        ? styles.billingStatTileOwed
                        : billingSummary.balance < 0
                          ? styles.billingStatTileCredit
                          : null,
                    ]}
                  >
                    <Text style={[styles.billingStatLabel, isRTL && styles.rtlText]}>{t("billing.balance")}</Text>
                    <Text
                      style={[
                        styles.billingStatValue,
                        isRTL && styles.rtlText,
                        billingSummary.balance > 0
                          ? styles.billingStatValueOwed
                          : billingSummary.balance < 0
                            ? styles.billingStatValueCredit
                            : null,
                      ]}
                      numberOfLines={2}
                    >
                      {billingSummary.balance > 0
                        ? t("billing.balanceOwes").replace(
                            "{n}",
                            String(Math.round(Math.abs(billingSummary.balance) * 100) / 100)
                          )
                        : billingSummary.balance < 0
                          ? t("billing.balanceCredit").replace(
                              "{n}",
                              String(Math.round(Math.abs(billingSummary.balance) * 100) / 100)
                            )
                          : t("billing.balanceEven")}
                    </Text>
                  </View>
                </View>
                {billingSummary.byMethod.length > 0 ? (
                  <View style={styles.billingMethodsBlock}>
                    <Text style={[styles.billingMethodsTitle, isRTL && styles.rtlText]}>{t("billing.byMethod")}</Text>
                    <View style={[styles.billingMethodGrid, rtlRowFlip && styles.billingMethodGridRtl]}>
                      {billingSummary.byMethod.map((x) => (
                        <View key={x.key} style={styles.billingMethodTile}>
                          <Text style={[styles.billingMethodLabel, isRTL && styles.rtlText]} numberOfLines={1}>
                            {paymentMethodHistoryLabel(x.key, language)}
                          </Text>
                          <Text style={[styles.billingMethodValue, isRTL && styles.rtlText]}>
                            {`${Math.round(x.total * 100) / 100} ₪`}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
                {billingSummary.missingRuleCount > 0 ? (
                  <Text style={[styles.billingWarn, isRTL && styles.rtlText]}>
                    {t("billing.missingRules").replace("{n}", String(billingSummary.missingRuleCount))}
                  </Text>
                ) : null}
                <Pressable
                  style={({ pressed }) => [styles.addPayBtn, pressed && { opacity: 0.9 }]}
                  onPress={() => {
                    setEditAccountPayment(null);
                    setAddPayOpen(true);
                  }}
                >
                  <Text style={styles.addPayBtnTxt}>{t("billing.addPayment")}</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        }
        renderSectionHeader={({ section: { title } }) => (
          <View style={[styles.sectionHead, isRTL && styles.sectionHeadRtl]}>
            <Text style={[styles.sectionTitle, isRTL && styles.rtlText]} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === "payment") {
            const p = item.pay;
            const amt = parseMoney(p.amount_ils);
            const amtTxt = amt !== null && amt > 0 ? `${amt} ₪` : "—";
            const busyPay = deletingPaymentId === p.id;
            const recorder = (p.created_by_name ?? "").trim();
            const reporterLine = recorder
              ? t("participantHistory.reportedBy").replace("{name}", recorder)
              : t("participantHistory.reportedByUnknown");
            const payeeMember = resolveFamilyMemberByPayee(familyContext, p.payee_id, p.payee_is_manual);
            const assignedName = payeeMember?.name?.trim() || null;
            const payerName = (p.payer_name ?? "").trim();
            return (
              <View style={styles.row}>
                <View style={[styles.sessionCardBody, isRTL && styles.sessionCardBodyRtl]}>
                  <View style={[styles.sessionHeadRow, rtlRowFlip && styles.sessionHeadRowRtl]}>
                  <Text style={[styles.cardDate, isRTL && styles.rtlText]} numberOfLines={1}>
                    {formatISODateFullWithWeekdayAfter(p.paid_at, language)}
                  </Text>
                    <Text style={[styles.sessionAmount, isRTL ? styles.ltrText : undefined]}>{amtTxt}</Text>
                  </View>
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
                      setEditAccountPayment(p);
                      setAddPayOpen(true);
                    }}
                    disabled={busyPay}
                    style={({ pressed }) => [styles.actionBarItem, pressed && !busyPay && styles.actionBarItemPressed]}
                  >
                    <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]}>{t("participantHistory.editShort")}</Text>
                  </Pressable>
                  <View style={styles.actionBarSep} />
                  <Pressable
                    onPress={() => confirmDeleteAccountPayment(p.id)}
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
          const reg = item.reg;
          const hasPaymentMethod = isSessionPaymentRecorded(reg.payment_method);
          const amtRaw = reg.amount_paid;
          const amt =
            amtRaw !== null && amtRaw !== undefined && String(amtRaw).trim() !== ""
              ? Number(amtRaw)
              : null;
          const amtOk = amt !== null && Number.isFinite(amt);
          const recorder = (reg.payment_recorded_by_name ?? "").trim();
          const chargeNoShow = reg.charge_no_show === true;
          const showPaymentBlock =
            reg.reg_status === "active" &&
            (reg.attended === true || (reg.attended === false && chargeNoShow));
          const reporterLine = recorder
            ? t("participantHistory.reportedBy").replace("{name}", recorder)
            : t("participantHistory.reportedByUnknown");
          const reason = (reg.cancellation_reason ?? "").trim();
          const raw12 = reg.cancellation_within_12h;
          const within12 =
            raw12 === true || (raw12 == null && reg.cancellation_within_24h === true);
          const within12ExplicitFalse =
            raw12 === false || (raw12 == null && reg.cancellation_within_24h === false);
          const late =
            within12
              ? language === "he"
                ? "ביטול בתוך 12 ש׳ לפני האימון"
                : "Cancelled within 12h of session start"
              : within12ExplicitFalse
                ? language === "he"
                  ? "ביטול מעל 12 ש׳ מראש"
                  : "Cancelled more than 12h before session"
                : null;
          const feeCharged = reg.cancellation_charged === true;
          const staffCanEdit = isManagerHistory || isCoachHistory;
          const sessionPrice =
            typeof reg.max_participants === "number" && reg.max_participants > 0
              ? (() => {
                  const mk = memberKeyForRow(reg);
                  const rowTiers =
                    mk && athleteTiersByMember[mk] && athleteTiersByMember[mk]!.length > 0
                      ? athleteTiersByMember[mk]!
                      : athleteTiers;
                  return resolveSessionBillingPriceLocal({
                    customSlotPriceIls: sessionCustomPriceById[reg.session_id],
                    maxParticipants: reg.max_participants,
                    isKickbox: sessionKickboxById[reg.session_id] ?? false,
                    sessionDate: reg.session_date,
                    athleteTiers: rowTiers,
                    globalTiers,
                    globalKickboxTiers,
                  });
                })()
              : null;
          const metaLine =
            typeof reg.max_participants === "number" && reg.max_participants > 0
              ? sessionPrice != null
                ? t("participantHistory.sessionMeta").replace("{spots}", String(reg.max_participants)).replace("{price}", String(sessionPrice))
                : t("participantHistory.sessionMetaSpotsOnly").replace("{spots}", String(reg.max_participants))
              : null;
          const coachName = (sessionCoachById[reg.session_id] ?? "").trim();
          const attCurrent = attStatusFromRow(reg);
          const attOpen = expandedAttendanceId === reg.registration_id;
          const attLabel = attStatusLabel(attCurrent, t);
          const showPaidStatus = showPaymentBlock && hasPaymentMethod;
          const showUnpaidStatus = showPaymentBlock && !hasPaymentMethod;
          return (
            <View style={styles.row}>
              <View style={[styles.sessionCardBody, isRTL && styles.sessionCardBodyRtl]}>
                <View style={[styles.sessionHeadRow, rtlRowFlip && styles.sessionHeadRowRtl]}>
                  <Text style={[styles.cardDate, isRTL && styles.rtlText]} numberOfLines={2}>
                    {formatISODateFullWithWeekdayAfter(reg.session_date, language)}
                  </Text>
                  <Text style={[styles.sessionTime, isRTL && styles.sessionTimeRtl]} numberOfLines={1}>
                    {formatSessionStartTime(reg.start_time)}
                  </Text>
                </View>
                <View style={[styles.sessionSublineRow, rtlRowFlip && styles.sessionSublineRowRtl]}>
                  {familyContext || coachName || metaLine ? (
                    <View style={[styles.sessionSublineFlex, isRTL && styles.sessionSublineBlockRtl]}>
                      {familyContext ? (
                        <Text style={[styles.sessionSubline, styles.sessionMemberName, isRTL && styles.rtlText]} numberOfLines={1}>
                          {t("families.assignedTo").replace(
                            "{name}",
                            reg.athlete_name?.trim() || "—"
                          )}
                        </Text>
                      ) : null}
                      {coachName ? (
                        <Text
                          style={[styles.sessionSubline, isRTL ? styles.sessionCoachRtl : styles.ltrText]}
                          numberOfLines={1}
                        >
                          {coachName}
                        </Text>
                      ) : null}
                      {metaLine ? (
                        <Text style={[styles.sessionSubline, isRTL && styles.rtlText]} numberOfLines={1}>
                          {metaLine}
                        </Text>
                      ) : null}
                    </View>
                  ) : (
                    <View style={styles.sessionSublineFlex} />
                  )}
                  {reg.reg_status === "cancelled" ? (
                    <Text style={[styles.sessionStatusMuted, isRTL && styles.rtlText]}>
                      {language === "he" ? "בוטל" : "Cancelled"}
                    </Text>
                  ) : showPaidStatus || showUnpaidStatus ? (
                    showPaidStatus && amtOk ? (
                      <View style={[styles.sessionStatusInline, rtlRowFlip && styles.sessionStatusInlineRtl]}>
                        <Text style={[styles.sessionStatus, styles.sessionStatusPaid, isRTL && styles.rtlText]} numberOfLines={1}>
                          {t("participantHistory.paidBadge")}
                        </Text>
                        <Text style={[styles.sessionStatus, styles.sessionStatusPaid, styles.ltrText]} numberOfLines={1}>
                          {amt} ₪
                        </Text>
                      </View>
                    ) : (
                      <Text
                        style={[
                          styles.sessionStatus,
                          isRTL && styles.rtlText,
                          showPaidStatus ? styles.sessionStatusPaid : styles.sessionStatusUnpaid,
                        ]}
                        numberOfLines={1}
                      >
                        {showPaidStatus ? t("participantHistory.paidBadge") : t("participantHistory.unpaidBadge")}
                      </Text>
                    )
                  ) : reg.reg_status === "active" && !staffCanEdit ? (
                    <View style={[styles.sessionStatusInline, rtlRowFlip && styles.sessionStatusInlineRtl]}>
                      <AttStatusDot status={attCurrent} />
                      <Text style={[styles.sessionStatus, isRTL && styles.rtlText]} numberOfLines={1}>
                        {attLabel}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {showPaymentBlock && hasPaymentMethod ? (
                  <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]} numberOfLines={2}>
                    {[paymentMethodHistoryLabel(reg.payment_method, language), reporterLine].filter(Boolean).join(" · ")}
                  </Text>
                ) : null}
              </View>

              {reg.reg_status === "active" && staffCanEdit ? (
                <>
                  {attOpen && attendanceBusyId !== `att:${reg.registration_id}` ? (
                    <View style={[styles.attPicker, rtlRowFlip && styles.attPickerRtl]}>
                      {(["unset", "arrived", "absent"] as const).map((status) => {
                        const on = attCurrent === status;
                        return (
                          <Pressable
                            key={status}
                            onPress={() => void applyAttendance(reg, status)}
                            style={({ pressed }) => [
                              styles.attPickerOpt,
                              on && styles.attPickerOptOn,
                              pressed && { opacity: 0.9 },
                            ]}
                          >
                            <AttStatusDot status={status} />
                            <Text style={[styles.attPickerTxt, on && styles.attPickerTxtOn, isRTL && styles.rtlText]}>
                              {attStatusLabel(status, t)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                  <View style={[styles.actionBar, rtlRowFlip && styles.actionBarRtl]}>
                    <Pressable
                      onPress={() =>
                        setExpandedAttendanceId((cur) =>
                          cur === reg.registration_id ? null : reg.registration_id
                        )
                      }
                      disabled={attendanceBusyId === `att:${reg.registration_id}`}
                      style={({ pressed }) => [
                        styles.actionBarItem,
                        styles.actionBarItemWide,
                        pressed && { opacity: 0.9 },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: attOpen }}
                    >
                      {attendanceBusyId === `att:${reg.registration_id}` ? (
                        <ActivityIndicator size="small" color={theme.colors.text} />
                      ) : (
                        <>
                          <AttStatusDot status={attCurrent} />
                          <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]} numberOfLines={1}>
                            {attLabel}
                          </Text>
                          <Text style={styles.actionBarChevron}>{attOpen ? "▴" : "▾"}</Text>
                        </>
                      )}
                    </Pressable>
                    {reg.attended === true ? (
                      <>
                        <View style={styles.actionBarSep} />
                        <Pressable
                          onPress={() => openEditAmount(reg)}
                          style={({ pressed }) => [styles.actionBarItem, pressed && styles.actionBarItemPressed]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]}>
                            {hasPaymentMethod
                              ? t("participantHistory.editShort")
                              : t("participantHistory.payShort")}
                          </Text>
                        </Pressable>
                      </>
                    ) : null}
                    <View style={styles.actionBarSep} />
                    <Pressable
                      onPress={() => confirmRemoveRegistration(reg)}
                      disabled={removingRegId === reg.registration_id}
                      style={({ pressed }) => [
                        styles.actionBarItem,
                        styles.actionBarItemDanger,
                        pressed && removingRegId !== reg.registration_id && styles.actionBarItemPressed,
                      ]}
                      accessibilityRole="button"
                    >
                      {removingRegId === reg.registration_id ? (
                        <ActivityIndicator size="small" color={theme.colors.error} />
                      ) : (
                        <Text style={[styles.actionBarLabelDanger, isRTL && styles.rtlText]}>
                          {t("participantHistory.removeShort")}
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </>
              ) : null}

              {reg.reg_status === "active" && reg.attended === false && staffCanEdit ? (
                <View style={styles.cardInset}>
                  <Text style={[styles.cardInsetLabel, isRTL && styles.rtlText]}>
                    {t("participantHistory.noShowChargeHeading")}
                  </Text>
                  {policyBusyId === `ns:${reg.registration_id}` ? (
                    <ActivityIndicator color={theme.colors.cta} style={styles.cardSpinner} />
                  ) : (
                    <View style={[styles.actionBar, styles.actionBarInset, rtlRowFlip && styles.actionBarRtl]}>
                      <Pressable
                        onPress={() => void applyNoShowCharge(reg, false)}
                        style={({ pressed }) => [
                          styles.actionBarItem,
                          !chargeNoShow && styles.actionBarItemActive,
                          pressed && { opacity: 0.9 },
                        ]}
                      >
                        <Text style={[styles.actionBarLabel, !chargeNoShow && styles.actionBarLabelActive, isRTL && styles.rtlText]}>
                          {t("managerSession.cancelChargeWaive")}
                        </Text>
                      </Pressable>
                      <View style={styles.actionBarSep} />
                      <Pressable
                        onPress={() => void applyNoShowCharge(reg, true)}
                        style={({ pressed }) => [
                          styles.actionBarItem,
                          chargeNoShow && styles.actionBarItemActive,
                          pressed && { opacity: 0.9 },
                        ]}
                      >
                        <Text style={[styles.actionBarLabel, chargeNoShow && styles.actionBarLabelActive, isRTL && styles.rtlText]}>
                          {t("managerSession.cancelChargeApply")}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ) : null}

              {reg.reg_status === "cancelled" ? (
                <View style={styles.cardSubsection}>
                  {reason.length > 0 ? (
                    <Text style={[styles.cardNote, isRTL && styles.rtlText]}>
                      {language === "he" ? "סיבה: " : "Reason: "}
                      {reason}
                    </Text>
                  ) : null}
                  {late ? (
                    <View style={[styles.badge, within12 ? styles.badgeLate : styles.badgeLateOk, styles.badgeInline]}>
                      <Text style={[styles.badgeTxt, within12 ? styles.badgeLateTxt : styles.badgeLateOkTxt]}>{late}</Text>
                    </View>
                  ) : null}
                  {within12 && isManagerHistory && reg.cancellation_id ? (
                    policyBusyId === `lc:${reg.cancellation_id}` ? (
                      <ActivityIndicator color={theme.colors.cta} style={styles.cardSpinner} />
                    ) : (
                      <View style={[styles.policySeg, rtlRowFlip && styles.policySegRtl, styles.lateFeeSegMargin]}>
                        <Pressable
                          onPress={() => void applyLateCancellationCharge(String(reg.cancellation_id), false)}
                          style={({ pressed }) => [
                            styles.policyBtn,
                            !feeCharged && styles.policyBtnOn,
                            pressed && { opacity: 0.88 },
                          ]}
                        >
                          <Text style={[styles.policyBtnTxt, !feeCharged && styles.policyBtnTxtOn]}>
                            {t("managerSession.cancelChargeWaive")}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void applyLateCancellationCharge(String(reg.cancellation_id), true)}
                          style={({ pressed }) => [
                            styles.policyBtn,
                            feeCharged && styles.policyBtnOn,
                            pressed && { opacity: 0.88 },
                          ]}
                        >
                          <Text style={[styles.policyBtnTxt, feeCharged && styles.policyBtnTxtOn]}>
                            {t("managerSession.cancelChargeApply")}
                          </Text>
                        </Pressable>
                      </View>
                    )
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!athleteId
              ? language === "he"
                ? "בחרו מתאמן כדי לראות את הפעילות."
                : "Choose an athlete to see their activity."
              : !hasSearched || loading
                ? ""
                : emptyHint}
          </Text>
        }
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  rtlText: { textAlign: "right", writingDirection: "rtl" },
  ltrText: { textAlign: "left", writingDirection: "ltr" },
  filters: {
    margin: theme.spacing.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
  },
  familyBanner: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 6,
  },
  familyBannerTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted, lineHeight: 18 },
  familyMembersLabel: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  familyMemberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 4,
  },
  familyMemberRowRtl: { flexDirection: "row-reverse" },
  familyMemberName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "700", color: theme.colors.text },
  familyMemberPhone: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  sessionMemberName: { fontWeight: "800", color: theme.colors.text },
  screenTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.sm },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  hint: { marginTop: theme.spacing.sm, fontSize: 12, color: theme.colors.textMuted, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    backgroundColor: theme.colors.white,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerText: { fontSize: 16, color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, color: theme.colors.textSoftOnLight },
  clearSel: { marginTop: 8, alignSelf: "flex-start" },
  clearSelTxt: { color: theme.colors.textMuted, fontWeight: "700" },
  loadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: 10,
  },
  loadingBannerTxt: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxHeight: "75%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderMuted,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  modalClose: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "800" },
  modalSearchField: { marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.sm },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: {
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderMuted,
  },
  pickerItemName: { fontSize: 16, fontWeight: "700", color: theme.colors.text },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoft, textAlign: "center" },
  list: { flex: 1 },
  listContent: { paddingBottom: theme.spacing.xl, flexGrow: 1 },
  sectionHead: {
    backgroundColor: theme.colors.surfaceElevated,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.lg,
    marginHorizontal: theme.spacing.md,
  },
  sectionHeadRtl: { alignItems: "flex-end" },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  row: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  sessionCardBody: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.sm, gap: 4 },
  sessionCardBodyRtl: { alignItems: "stretch" },
  sessionHeadRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  sessionHeadRowRtl: { flexDirection: "row-reverse" },
  sessionSublineRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginTop: 2 },
  sessionSublineRowRtl: { flexDirection: "row-reverse" },
  sessionSublineFlex: { flex: 1, minWidth: 0 },
  sessionSublineBlockRtl: { alignItems: "flex-end" },
  sessionSubline: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  sessionCoachRtl: { textAlign: "right", writingDirection: "ltr" },
  sessionTime: { fontSize: 14, fontWeight: "600", color: theme.colors.textMuted, flexShrink: 0, writingDirection: "ltr" },
  sessionTimeRtl: { textAlign: "left" },
  sessionAmount: { fontSize: 17, fontWeight: "800", color: theme.colors.success, flexShrink: 0 },
  sessionStatus: { fontSize: 12, fontWeight: "700", flexShrink: 0 },
  sessionStatusPaid: { color: theme.colors.success },
  sessionStatusUnpaid: { color: "#fbbf24" },
  sessionStatusMuted: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, flexShrink: 0 },
  sessionStatusInline: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  sessionStatusInlineRtl: { flexDirection: "row-reverse" },
  sessionFootnote: { fontSize: 11, color: theme.colors.textSoft, lineHeight: 15, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  actionBar: {
    flexDirection: "row",
    alignItems: "stretch",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  actionBarRtl: { flexDirection: "row-reverse" },
  actionBarInset: { borderTopWidth: 0, borderRadius: theme.radius.md, overflow: "hidden" },
  actionBarItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    paddingHorizontal: 8,
    minHeight: 42,
  },
  actionBarItemWide: { flex: 1.35 },
  actionBarItemDanger: {},
  actionBarItemActive: { backgroundColor: theme.colors.cta },
  actionBarItemPressed: { opacity: 0.88 },
  actionBarSep: { width: StyleSheet.hairlineWidth, backgroundColor: theme.colors.borderMuted },
  actionBarLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.text },
  actionBarLabelActive: { color: theme.colors.ctaText, fontWeight: "700" },
  actionBarLabelDanger: { fontSize: 13, fontWeight: "600", color: theme.colors.error },
  actionBarChevron: { fontSize: 10, color: theme.colors.textSoft, marginTop: 1 },
  attPicker: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 4,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  attPickerRtl: { flexDirection: "row-reverse" },
  attPickerOpt: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
  },
  attPickerOptOn: { backgroundColor: theme.colors.cta },
  attPickerTxt: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
  attPickerTxtOn: { color: theme.colors.ctaText, fontWeight: "700" },
  cardInset: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: 6,
  },
  cardInsetLabel: { fontSize: 11, fontWeight: "600", color: theme.colors.textSoft },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  cardTopRtl: { flexDirection: "row-reverse" },
  cardDate: { fontSize: 16, fontWeight: "700", color: theme.colors.text, flexShrink: 1 },
  cardMeta: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 16 },
  cardNote: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginTop: 2,
  },
  cardSpinner: { marginVertical: 6 },
  cardLinks: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  cardLinksRtl: { flexDirection: "row-reverse" },
  cardLinkHit: { paddingVertical: 2 },
  cardLink: { fontSize: 13, fontWeight: "800", color: theme.colors.cta },
  cardLinkDanger: { color: theme.colors.error },
  cardLinkSep: { fontSize: 13, color: theme.colors.textSoft, fontWeight: "700" },
  cardPaymentSummary: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  cardPaymentSummaryRtl: { flexDirection: "row-reverse" },
  cardPaymentAmount: { fontSize: 16, fontWeight: "900", color: theme.colors.success },
  cardPaymentMethod: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  cardPaymentFoot: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    gap: 4,
  },
  cardPaymentFootPaid: {},
  cardUnpaid: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  cardSubsection: { gap: 8, paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm },
  cardSubLabel: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  badgeInline: { alignSelf: "flex-start", marginTop: 0 },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    flexShrink: 0,
  },
  badgeOn: { backgroundColor: theme.colors.successBg },
  badgeOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeTxt: { fontSize: 11, fontWeight: "800" },
  badgeTxtOn: { color: theme.colors.success },
  badgeTxtOff: { color: theme.colors.textMuted },
  badgeAtt: {},
  badgeAttYes: { backgroundColor: theme.colors.successBg, borderWidth: 0 },
  badgeAttTxtYes: { color: theme.colors.success },
  badgeAttNo: { backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  badgeAttTxtNo: { color: theme.colors.error },
  badgeAttUnset: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeAttTxtUnset: { color: theme.colors.textMuted },
  badgeLate: { marginTop: 6, backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  badgeLateTxt: { color: theme.colors.error },
  badgeLateOk: { marginTop: 6, backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeLateOkTxt: { color: theme.colors.textMuted },
  noShowPolicyBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  noShowPolicyBlockRtl: { alignItems: "stretch" },
  noShowPolicyLabel: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted, marginBottom: 8 },
  policySeg: { flexDirection: "row", gap: 8 },
  policySegRtl: { flexDirection: "row-reverse" },
  lateFeeSegMargin: { marginTop: 10 },
  policyBtn: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
  },
  policyBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  policyBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  policyBtnTxtOn: { color: theme.colors.ctaText },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl, fontSize: 14 },
  billingCard: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  billingTitle: { fontSize: 13, fontWeight: "900", color: theme.colors.textMuted, letterSpacing: 0.3, textTransform: "uppercase" },
  billingStatGrid: { flexDirection: "row", gap: 8 },
  billingStatGridRtl: { flexDirection: "row-reverse" },
  billingStatTile: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: 68,
  },
  billingStatTileOwed: { borderColor: theme.colors.errorBorder, backgroundColor: theme.colors.errorBg },
  billingStatTileCredit: { borderColor: "rgba(34,197,94,0.35)", backgroundColor: theme.colors.successBg },
  billingStatLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.25,
    textTransform: "uppercase",
    textAlign: "center",
  },
  billingStatValue: { fontSize: 15, fontWeight: "900", color: theme.colors.text, textAlign: "center", lineHeight: 18 },
  billingStatValueOwed: { color: theme.colors.error },
  billingStatValueCredit: { color: theme.colors.success },
  billingMethodsBlock: { gap: 6, marginTop: 2 },
  billingMethodsTitle: { fontSize: 10, fontWeight: "800", color: theme.colors.textMuted, letterSpacing: 0.25, textTransform: "uppercase" },
  billingMethodGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  billingMethodGridRtl: { flexDirection: "row-reverse" },
  billingMethodTile: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    gap: 2,
    minWidth: 72,
  },
  billingMethodLabel: { fontSize: 10, fontWeight: "800", color: theme.colors.textMuted, textAlign: "center" },
  billingMethodValue: { fontSize: 13, fontWeight: "900", color: theme.colors.text, textAlign: "center" },
  billingWarn: { fontSize: 12, color: theme.colors.textSoft, marginTop: 4, lineHeight: 17 },
  addPayBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  addPayBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  addPayBody: { padding: theme.spacing.md, gap: 8, paddingBottom: theme.spacing.lg },
  inputLight: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  methodRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  methodChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  methodChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  methodChipTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  methodChipTxtOn: { color: theme.colors.ctaText },
  paymentRow: { borderLeftWidth: 3, borderLeftColor: theme.colors.success },
  paymentStatusRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  paymentStatusRowRtl: { flexDirection: "row-reverse" },
  paymentPaidAmount: { fontSize: 18, fontWeight: "900", color: theme.colors.success },
  paymentMethodLine: { fontSize: 14, fontWeight: "700", color: theme.colors.text, marginTop: 4 },
  paymentMethodCash: { color: theme.colors.success },
  paymentMethodOther: { color: "#ca8a04" },
  paymentRecordedBy: { fontSize: 12, color: theme.colors.textMuted, marginTop: 4, lineHeight: 17 },
  paymentUnpaidHint: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4, lineHeight: 18 },
  sessionPaymentBlock: {
    marginTop: 8,
    padding: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    gap: 2,
  },
  sessionPaymentBlockPaid: {
    backgroundColor: "rgba(34, 197, 94, 0.08)",
    borderColor: "rgba(34, 197, 94, 0.35)",
  },
  sessionPaymentBlockUnpaid: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderMuted,
  },
  badgePayment: { backgroundColor: "rgba(96, 165, 250, 0.15)", borderWidth: 1, borderColor: theme.colors.cta },
  badgeTxtPayment: { color: theme.colors.cta },
  paymentRowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
  },
  paymentRowHeadRtl: { flexDirection: "row-reverse" },
  paymentRowActions: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  paymentRowActionsRtl: { flexDirection: "row-reverse" },
  paymentRowDate: { flex: 1, minWidth: 0 },
  paymentEditBtn: { paddingVertical: 6, paddingHorizontal: 8 },
  paymentEditTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.cta },
  paymentDeleteBtn: { paddingVertical: 6, paddingHorizontal: 8 },
  paymentDeleteTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.error },
  inlineAction: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  inlineActionTxt: { color: theme.colors.cta, fontWeight: "900", letterSpacing: 0.1 },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  rowActionsRtl: { flexDirection: "row-reverse" },
  attendanceBlock: { marginTop: 10, gap: 6 },
  attendanceBlockRtl: { alignItems: "flex-end" },
  attendanceLabel: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted, letterSpacing: 0.2 },
  inlineActionDanger: {
    borderColor: "rgba(239, 68, 68, 0.35)",
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },
  inlineActionDangerTxt: { color: theme.colors.error, fontWeight: "900", letterSpacing: 0.1 },
});
