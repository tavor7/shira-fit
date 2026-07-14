import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, SectionList, Pressable, Platform } from "react-native";
import { useLocalSearchParams, usePathname, useRouter, type Href } from "expo-router";
import { ReportDateRangeControls } from "../components/ReportDateRangeControls";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { EmptyState } from "../components/EmptyState";
import { AddAccountPaymentModal } from "../components/AddAccountPaymentModal";
import { AppSearchSheet } from "../components/AppSearchSheet";
import { supabase } from "../lib/supabase";
import { athletePickerLabel, athleteSearchSubtitle } from "../lib/displayName";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { isValidISODateString, lastNDaysRangeISO } from "../lib/isoDate";
import { formatISODateFull } from "../lib/dateFormat";
import type { AthleteAccountPayment, ParticipantHistoryRow } from "../types/database";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import {
  coerceSessionPaymentMethodKey,
  normalizePaymentMethodKey,
  paymentMethodHistoryLabel,
  isSessionPaymentRecorded,
  type SessionPaymentMethodKey,
} from "../lib/paymentMethod";
import {
  type AthleteFamily,
  type AthleteFamilyMember,
  memberPayeeKey,
  fetchAthleteFamilyForPayee,
  resolveFamilyMemberByPayee,
} from "../lib/athleteFamilies";
import type { PricingRateTierRow } from "../lib/pricingRates";
import {
  computeBillingSummary,
  mergedHistorySections,
  parseMoney,
  type Athlete,
  type PickerRow,
  type QuickLinked,
} from "../lib/participantHistoryHelpers";
import { participantHistoryStyles as styles } from "./participantHistoryStyles";
import { PaymentHistoryRow } from "../components/PaymentHistoryRow";
import { SessionHistoryRow } from "../components/SessionHistoryRow";
import { EditSessionAmountModal } from "../components/EditSessionAmountModal";

export default function ParticipantHistoryScreen({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const { presetUserId, presetManualId, presetStart, presetEnd } = useLocalSearchParams<{
    presetUserId?: string;
    presetManualId?: string;
    presetStart?: string;
    presetEnd?: string;
  }>();
  const presetUid =
    typeof presetUserId === "string" ? presetUserId : Array.isArray(presetUserId) ? presetUserId[0] : undefined;
  const presetManual =
    typeof presetManualId === "string"
      ? presetManualId
      : Array.isArray(presetManualId)
        ? presetManualId[0]
        : undefined;
  const presetStartIso =
    typeof presetStart === "string" ? presetStart : Array.isArray(presetStart) ? presetStart[0] : undefined;
  const presetEndIso =
    typeof presetEnd === "string" ? presetEnd : Array.isArray(presetEnd) ? presetEnd[0] : undefined;
  const awaitingPresetAthlete = !!(presetUid || presetManual);
  const { language, t, isRTL } = useI18n();
  /** Web sets `html dir=rtl`; extra row-reverse there mirrors layout twice. */
  const rtlRowFlip = isRTL && Platform.OS !== "web";
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const pathname = usePathname();
  const router = useRouter();
  const isCoachHistory = pathname?.startsWith("/coach/participant-history") ?? false;
  /** Dedicated route or Reports hub athlete tab (embedded via ManagerReportsScreen). */
  const isManagerHistory =
    (pathname?.startsWith("/manager/participant-history") ?? false) ||
    (pathname?.startsWith("/manager/reports") ?? false);

  const openSession = useCallback(
    (sessionId: string) => {
      const href = (
        isCoachHistory ? `/(app)/coach/session/${sessionId}` : `/(app)/manager/session/${sessionId}`
      ) as Href;
      router.push(href);
    },
    [isCoachHistory, router]
  );
  const [start, setStart] = useState(() => {
    if (presetStartIso && isValidISODateString(presetStartIso.trim())) return presetStartIso.trim();
    return lastNDaysRangeISO(30).start;
  });
  const [end, setEnd] = useState(() => {
    if (presetEndIso && isValidISODateString(presetEndIso.trim())) return presetEndIso.trim();
    return lastNDaysRangeISO(30).end;
  });
  const [presetResolved, setPresetResolved] = useState(!awaitingPresetAthlete);
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
  const [emptyHint, setEmptyHint] = useState<string>(t("participantHistory.emptyDefault"));
  const [editAmountOpen, setEditAmountOpen] = useState(false);
  const [editAmountBusy, setEditAmountBusy] = useState(false);
  const [editAmountStr, setEditAmountStr] = useState("");
  const [editMethod, setEditMethod] = useState<SessionPaymentMethodKey | "">("");
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
    setEditMethod(coerceSessionPaymentMethodKey(reg.payment_method, ""));
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
      const family = await fetchAthleteFamilyForPayee(athleteId, payeeIsManual);
      setFamilyContext(family);
    })();
  }, [athleteId, payeeIsManual]);

  useEffect(() => {
    const uid = presetUid;
    if (!uid) return;
    void (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, username, phone")
        .eq("user_id", uid)
        .maybeSingle();
      if (error || !data) {
        setPresetResolved(true);
        return;
      }
      setAthleteId(uid);
      setPayeeIsManual(false);
      setAthleteLabel(athletePickerLabel(data.full_name ?? "", data.phone));
      setPhone((data.phone ?? "").trim());
      setPresetResolved(true);
    })();
  }, [presetUid]);

  useEffect(() => {
    const mid = presetManual;
    if (!mid || presetUid) return;
    void (async () => {
      const { data, error } = await supabase
        .from("manual_participants")
        .select("full_name, phone, linked_user_id")
        .eq("id", mid)
        .maybeSingle();
      if (error || !data) {
        setPresetResolved(true);
        return;
      }
      const linked = (data.linked_user_id ?? "").trim() || null;
      setAthleteId(linked ?? mid);
      setPayeeIsManual(!linked);
      setAthleteLabel(
        `${data.full_name} · ${data.phone ?? ""} · ${
          linked
            ? language === "he"
              ? "קישור מרשימת מהיר"
              : "Quick Add link"
            : language === "he"
              ? "ללא חשבון"
              : "No account"
        }`
      );
      setPhone((data.phone ?? "").trim());
      setPresetResolved(true);
    })();
  }, [presetManual, presetUid, language]);

  useEffect(() => {
    if (presetStartIso && isValidISODateString(presetStartIso.trim())) {
      setStart(presetStartIso.trim());
    }
    if (presetEndIso && isValidISODateString(presetEndIso.trim())) {
      setEnd(presetEndIso.trim());
    }
  }, [presetStartIso, presetEndIso]);

  const loadAthletes = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .is("disabled_at", null)
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;

    let mQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .is("disabled_at", null)
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

    const activeFamily = await fetchAthleteFamilyForPayee(athleteId, payeeIsManual);
    setFamilyContext(activeFamily);

    const familyId = activeFamily?.id ?? null;
    const familyMembers = activeFamily?.members ?? [];
    const phoneArg =
      familyId ? null : phone.trim().length > 0 ? phone.trim() : null;

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
  }, [start, end, phone, athleteId, payeeIsManual, language]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!athleteId || !presetResolved) return;
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e) || s > e) return;
    void loadRef.current();
  }, [athleteId, start, end, payeeIsManual, presetResolved]);

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
                setAthleteLabel(athletePickerLabel(item.full_name, item.phone));
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
              {item.kind === "athlete" ? athleteSearchSubtitle(item.phone) : `${item.phone} · ${t("participantHistory.quickAdd")}`}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<EmptyState icon="🔍" title={t("participantHistory.noAthletes")} isRTL={isRTL} />}
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

      <EditSessionAmountModal
        visible={editAmountOpen}
        onClose={() => {
          if (editAmountBusy) return;
          setEditAmountOpen(false);
          setEditReg(null);
        }}
        busy={editAmountBusy}
        reg={editReg}
        method={editMethod}
        onMethodChange={setEditMethod}
        amountStr={editAmountStr}
        onAmountStrChange={setEditAmountStr}
        onSave={() => void saveEditAmount()}
        language={language}
        isRTL={isRTL}
        t={t}
      />

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
              <ReportDateRangeControls
                start={start}
                end={end}
                onChange={({ start: s, end: e }) => {
                  setStart(s);
                  setEnd(e);
                }}
              />
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
                <View style={styles.familyBannerHead}>
                  <Text style={[styles.familyBannerTitle, isRTL && styles.rtlText]} numberOfLines={2}>
                    {familyContext.name}
                  </Text>
                  <Text style={[styles.familyBannerMeta, isRTL && styles.rtlText]}>
                    {t("families.reportMeta").replace("{n}", String(familyContext.members.length))}
                  </Text>
                </View>
                <View style={styles.familyMembersPanel}>
                  <Text style={[styles.familyMembersLabel, isRTL && styles.rtlText]}>
                    {t("families.reportMembers")}
                  </Text>
                  {familyContext.members.map((m) => {
                    const phone = (m.phone ?? "").trim();
                    return (
                      <View key={memberPayeeKey(m.kind, m.id)} style={styles.familyMemberCard}>
                        <View style={[styles.familyMemberMain, rtlRowFlip && styles.familyMemberMainRtl]}>
                          <Text style={[styles.familyMemberName, isRTL && styles.rtlText]} numberOfLines={1}>
                            {m.name?.trim() || "—"}
                          </Text>
                          {m.kind === "manual" ? (
                            <View style={styles.familyMemberBadge}>
                              <Text style={styles.familyMemberBadgeTxt}>
                                {language === "he" ? "מהיר" : "Quick Add"}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text
                          style={[
                            styles.familyMemberPhone,
                            isRTL ? styles.familyMemberPhoneRtl : styles.ltrText,
                          ]}
                          numberOfLines={1}
                        >
                          {phone || "—"}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {athleteId && loading ? (
              <View style={styles.loadingSkeletonStack}>
                <ListRowSkeleton />
                <ListRowSkeleton />
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
        renderItem={({ item }) =>
          item.kind === "payment" ? (
            <PaymentHistoryRow
              pay={item.pay}
              familyContext={familyContext}
              isRTL={isRTL}
              rtlRowFlip={rtlRowFlip}
              language={language}
              t={t}
              deletingPaymentId={deletingPaymentId}
              onEdit={(pay) => {
                setEditAccountPayment(pay);
                setAddPayOpen(true);
              }}
              onDelete={confirmDeleteAccountPayment}
            />
          ) : (
            <SessionHistoryRow
              reg={item.reg}
              isRTL={isRTL}
              rtlRowFlip={rtlRowFlip}
              language={language}
              t={t}
              familyContext={familyContext}
              isManagerHistory={isManagerHistory}
              isCoachHistory={isCoachHistory}
              memberKeyForRow={memberKeyForRow}
              athleteTiersByMember={athleteTiersByMember}
              athleteTiers={athleteTiers}
              globalTiers={globalTiers}
              globalKickboxTiers={globalKickboxTiers}
              sessionCustomPriceById={sessionCustomPriceById}
              sessionKickboxById={sessionKickboxById}
              sessionCoachById={sessionCoachById}
              expandedAttendanceId={expandedAttendanceId}
              attendanceBusyId={attendanceBusyId}
              removingRegId={removingRegId}
              policyBusyId={policyBusyId}
              openSession={openSession}
              applyAttendance={applyAttendance}
              setExpandedAttendanceId={setExpandedAttendanceId}
              openEditAmount={openEditAmount}
              confirmRemoveRegistration={confirmRemoveRegistration}
              applyNoShowCharge={applyNoShowCharge}
              applyLateCancellationCharge={applyLateCancellationCharge}
            />
          )
        }
        ListEmptyComponent={
          !athleteId ? (
            <EmptyState icon="🧑" title={t("participantHistory.chooseAthlete")} isRTL={isRTL} />
          ) : !hasSearched || loading ? null : (
            <EmptyState icon="📭" title={emptyHint} isRTL={isRTL} />
          )
        }
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}
