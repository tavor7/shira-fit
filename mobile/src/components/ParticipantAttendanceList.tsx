import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, View, Text, Pressable, StyleSheet, ActivityIndicator, Modal, TextInput, Keyboard, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { router, usePathname } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { AppIcon } from "./AppIcon";
import { IconButton } from "./IconButton";
import { LAYOUT } from "../lib/screenLayout";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { isBirthdayToday } from "../lib/birthday";
import { ListRowSkeleton } from "./ListRowSkeleton";
import { PressableScale } from "./PressableScale";
import { FadeSlideIn } from "./FadeSlideIn";
import { CrossfadeSwap } from "./CrossfadeSwap";
import {
  normalizePaymentMethodKey,
  paymentMethodAttendanceLabel,
  paymentDisplayTone,
  SESSION_PAYMENT_METHOD_KEYS,
} from "../lib/paymentMethod";
import { fetchSessionBillingPriceIls, resolveRowBillingPriceIls } from "../lib/sessionSlotPrice";
import { RosterSlotRateChip, formatRosterIls, type SessionRateMeta } from "./RosterSlotRateChip";
import { fetchActiveSignupCountsBySession } from "../lib/sessionSignupCounts";
import { fetchSessionRegistrationsWithProfiles } from "../lib/sessionRosterQueries";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { hasSessionNotStarted } from "../lib/sessionTime";
import type { MoveParticipantTarget } from "./MoveParticipantSheet";
import { rowFlipFor, userContentTextProps } from "../lib/layoutDirection";
import { displayLtr, displayMoney } from "../lib/displayFormat";

type RegRow = {
  user_id: string;
  attended: boolean | null;
  charge_no_show?: boolean | null;
  payment_method?: string | null;
  amount_paid?: number | string | null;
  profile: {
    full_name: string;
    username?: string;
    phone?: string | null;
    date_of_birth?: string | null;
  } | null;
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
  /** When roster is empty but another session at the same slot has athletes. */
  onDuplicateRosterSession?: (otherSessionId: string | null) => void;
  /** Staff: open move-to-another-session flow for a roster row. */
  onMoveParticipant?: (target: MoveParticipantTarget) => void;
  /** Super User only: user_ids currently hidden from this session (drives badge + toggle). */
  superUserHiddenUserIds?: Set<string>;
  /** Super User only: hide/unhide an athlete for this session. `scope` is set (and required) when hiding. Omit to hide the control entirely. */
  onToggleHideAthlete?: (userId: string, currentlyHidden: boolean) => void | Promise<void>;
};

/** Brief accent wash over a newly-added roster row, fading out as it "settles" into the list. */
function EnteringHighlight() {
  const opacity = useRef(new Animated.Value(1)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (reduceMotionRef.current) {
      opacity.setValue(0);
      return;
    }
    Animated.timing(opacity, {
      toValue: 0,
      duration: theme.motion.normal + 400,
      easing: theme.motion.easeOut,
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: "rgba(34,197,94,0.18)", borderRadius: theme.radius.md, opacity },
      ]}
    />
  );
}

export function ParticipantAttendanceList({
  sessionId,
  onChanged,
  onParticipantCountChange,
  onAttendanceStatsChange,
  refreshNonce = 0,
  onRemoveAthlete,
  onRemoveManualParticipant,
  showMarkAllArrived = true,
  onDuplicateRosterSession,
  onMoveParticipant,
  superUserHiddenUserIds,
  onToggleHideAthlete,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const pathname = usePathname();
  const { showConfirm, showAlert, showOk } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [hideToggleBusyUserId, setHideToggleBusyUserId] = useState<string | null>(null);
  const [maxParticipants, setMaxParticipants] = useState<number | null>(null);
  const [sessionMeta, setSessionMeta] = useState<SessionRateMeta | null>(null);
  const [rosterPriceByRowId, setRosterPriceByRowId] = useState<Record<string, number>>({});
  const [effectivePriceByRowId, setEffectivePriceByRowId] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [duplicateRosterSessionId, setDuplicateRosterSessionId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payFor, setPayFor] = useState<Row | null>(null);
  const [payPhase, setPayPhase] = useState<"method" | "amount">("method");
  const [payChosenMethod, setPayChosenMethod] = useState<string | null>(null);
  const [payAmountDraft, setPayAmountDraft] = useState("");
  const [payMode, setPayMode] = useState<"arrived" | "absent_penalty">("arrived");
  const [sessionNotStarted, setSessionNotStarted] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(new Set());
  const prevIdsRef = useRef<Set<string> | null>(null);
  const enteringClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function interpolateParticipantName(template: string, name: string) {
    return template.replace(/\{name\}/g, name);
  }

  const canOfferDecreaseGroupSize = maxParticipants != null && maxParticipants < 12 && maxParticipants > 1 && rows.length >= maxParticipants;

  function rowCanMove(item: Row): boolean {
    if (item.attended !== null) return false;
    if (item.chargeNoShow) return false;
    if (item.amountPaid != null) return false;
    if (normalizePaymentMethodKey(item.paymentMethod) !== "(none)") return false;
    return true;
  }

  function openMove(item: Row) {
    if (!onMoveParticipant || !rowCanMove(item)) return;
    onMoveParticipant(
      item.kind === "registered"
        ? { kind: "registered", name: item.name, userId: item.userId }
        : { kind: "manual", name: item.name, manualId: item.manualId }
    );
  }

  function confirmRemoveRegistered(item: Extract<Row, { kind: "registered" }>) {
    if (!onRemoveAthlete) return;
    showConfirm({
      title: t("managerSession.removeParticipantConfirmTitle"),
      message: interpolateParticipantName(t("managerSession.removeParticipantConfirmMessage"), item.name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("managerSession.removeParticipantConfirmRemove"),
      confirmVariant: "danger",
      onConfirm: () => {
        // Optional second prompt: for small (<12) FULL sessions, also decrease max participants by 1.
        if (canOfferDecreaseGroupSize) {
          showAlert({
            title: t("managerSession.decreaseGroupSizeTitle"),
            message: t("managerSession.decreaseGroupSizeMessage"),
            actions: [
              {
                label: t("common.cancel"),
                variant: "secondary",
                onPress: () => void Promise.resolve(onRemoveAthlete(item.userId)),
              },
              {
                label: t("managerSession.decreaseGroupSizeConfirm"),
                variant: "primary",
                onPress: () => {
                  void (async () => {
                    if (!maxParticipants || maxParticipants <= 1) {
                      await Promise.resolve(onRemoveAthlete(item.userId));
                      return;
                    }
                    const nextMax = maxParticipants - 1;
                    await Promise.resolve(onRemoveAthlete(item.userId));

                    // Update max participants after the athlete is removed to avoid transient capacity violations.
                    const { error: capErr } = await supabase
                      .from("training_sessions")
                      .update({ max_participants: nextMax })
                      .eq("id", sessionId);
                    if (capErr) showOk(t("common.error"), capErr.message);
                    else setMaxParticipants(nextMax);
                  })();
                },
              },
            ],
          });
          return;
        }

        void Promise.resolve(onRemoveAthlete(item.userId));
      },
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

  function confirmToggleHideAthlete(item: Extract<Row, { kind: "registered" }>, currentlyHidden: boolean) {
    if (!onToggleHideAthlete) return;
    const titleKey = currentlyHidden ? "superUser.unhideConfirmTitle" : "superUser.hideConfirmTitle";
    const messageKey = currentlyHidden ? "superUser.unhideConfirmMessage" : "superUser.hideConfirmMessage";
    const confirmLabelKey = currentlyHidden ? "superUser.unhide" : "superUser.hideAction";
    showConfirm({
      title: t(titleKey),
      message: interpolateParticipantName(t(messageKey), item.name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t(confirmLabelKey),
      confirmVariant: currentlyHidden ? "primary" : "danger",
      onConfirm: () => {
        void (async () => {
          setHideToggleBusyUserId(item.userId);
          try {
            await Promise.resolve(onToggleHideAthlete(item.userId, currentlyHidden));
          } finally {
            setHideToggleBusyUserId(null);
          }
        })();
      },
    });
  }

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) {
      setLoading(true);
    }
    setLoadError(null);
    setDuplicateRosterSessionId(null);
    onDuplicateRosterSession?.(null);

    const { data: s } = await supabase
      .from("training_sessions")
      .select("max_participants, session_date, start_time, coach_id, is_kickbox, custom_slot_price_ils")
      .eq("id", sessionId)
      .single();
    const sess = s as {
      max_participants?: number;
      session_date?: string;
      start_time?: string;
      is_kickbox?: boolean;
      custom_slot_price_ils?: number | string | null;
    } | null;
    setMaxParticipants(sess?.max_participants ?? null);
    setSessionNotStarted(
      !!(sess?.session_date && sess?.start_time && hasSessionNotStarted(sess.session_date, sess.start_time))
    );
    if (sess?.max_participants && sess.session_date) {
      const custom = sess.custom_slot_price_ils;
      setSessionMeta({
        max_participants: sess.max_participants,
        is_kickbox: !!sess.is_kickbox,
        session_date: sess.session_date,
        custom_slot_price_ils:
          custom != null && custom !== "" && Number.isFinite(Number(custom)) ? Number(custom) : null,
      });
    } else {
      setSessionMeta(null);
    }

    const { data: rosterPriceRows } = await supabase
      .from("session_roster_slot_prices")
      .select("user_id, manual_participant_id, price_ils")
      .eq("session_id", sessionId);
    const rosterMap: Record<string, number> = {};
    for (const rp of (rosterPriceRows as { user_id?: string; manual_participant_id?: string; price_ils: number | string }[] | null) ?? []) {
      const key = rp.user_id ? `u:${rp.user_id}` : `m:${rp.manual_participant_id}`;
      const n = Number(rp.price_ils);
      if (key && Number.isFinite(n)) rosterMap[key] = n;
    }

    let regRes = await fetchSessionRegistrationsWithProfiles(sessionId);

    let manRes = await supabase
      .from("session_manual_participants")
      .select("manual_participant_id, attended, charge_no_show, payment_method, amount_paid, manual_participants(full_name, phone, date_of_birth)")
      .eq("session_id", sessionId);
    if (manRes.error && isMissingColumnError(manRes.error.message, "date_of_birth")) {
      manRes = (await supabase
        .from("session_manual_participants")
        .select("manual_participant_id, attended, charge_no_show, payment_method, amount_paid, manual_participants(full_name, phone)")
        .eq("session_id", sessionId)) as typeof manRes;
    }

    const { data, error } = { data: regRes.rows, error: regRes.error ? { message: regRes.error } : null };
    const { data: mData, error: mErr } = manRes;
    const errors = [error?.message, mErr?.message].filter(Boolean);

    if (error && mErr) {
      setRows([]);
      setLoadError(errors.join(" · "));
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

    if (errors.length > 0) {
      setLoadError(errors.join(" · "));
    }

    const regRows: Row[] = ((data as RegRow[]) ?? []).map((r) => {
      const p = r.profile;
      return {
        kind: "registered",
        id: `u:${r.user_id}`,
        userId: r.user_id,
        name: p?.full_name ?? "—",
        phone: p?.phone ? String(p.phone) : "",
        attended: r.attended ?? null,
        chargeNoShow: !!r.charge_no_show,
        paymentMethod: r.payment_method ?? null,
        amountPaid: coerceAmountPaid(r.amount_paid),
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
    const effectiveMap: Record<string, number> = {};
    const metaForBilling =
      sess?.max_participants && sess.session_date
        ? {
            max_participants: sess.max_participants,
            is_kickbox: !!sess.is_kickbox,
            session_date: sess.session_date,
            custom_slot_price_ils:
              sess.custom_slot_price_ils != null &&
              sess.custom_slot_price_ils !== "" &&
              Number.isFinite(Number(sess.custom_slot_price_ils))
                ? Number(sess.custom_slot_price_ils)
                : null,
          }
        : null;

    for (const r of all) {
      if (normalizePaymentMethodKey(r.paymentMethod) !== "(none)") withPaymentMethod += 1;
      if (r.amountPaid != null && r.amountPaid > 0) totalPaidIls += r.amountPaid;
      if (r.attended === false && r.chargeNoShow) {
        noShowChargedCount += 1;
        if (r.amountPaid != null && r.amountPaid > 0) noShowCollectedIls += r.amountPaid;
      }
    }

    // Fire every roster row's price lookup concurrently instead of one-at-a-time —
    // with N participants this turns N sequential round-trips into one wait.
    let priceFetchFailed = false;
    const prices = await Promise.all(
      all.map(async (r) => {
        const userId = r.kind === "registered" ? r.userId : null;
        const manualParticipantId = r.kind === "manual" ? r.manualId : null;
        const rosterOverride = rosterMap[r.id] ?? null;
        try {
          return metaForBilling
            ? await resolveRowBillingPriceIls(
                supabase,
                sessionId,
                userId,
                manualParticipantId,
                metaForBilling,
                rosterOverride
              )
            : await fetchSessionBillingPriceIls(supabase, sessionId, userId, manualParticipantId);
        } catch {
          priceFetchFailed = true;
          return 0;
        }
      })
    );
    all.forEach((r, i) => {
      const price = prices[i];
      effectiveMap[r.id] = price;
      const owes = r.attended === true || (r.attended === false && r.chargeNoShow);
      if (owes) {
        expectedPaymentSlots += 1;
        expectedPaymentsIls += price;
      }
    });
    if (priceFetchFailed) {
      const msg = t("attendance.failedToLoadPrices");
      setLoadError((prev) => (prev ? `${prev} · ${msg}` : msg));
    }
    setRosterPriceByRowId(rosterMap);
    setEffectivePriceByRowId(effectiveMap);
    setRows(all);

    // Mark rows that weren't in the previous roster as "entering" so they animate in —
    // skip on the very first load so the initial roster never flashes as new.
    const isFirstLoad = prevIdsRef.current === null;
    const newIds = isFirstLoad
      ? new Set<string>()
      : new Set(all.filter((r) => !prevIdsRef.current!.has(r.id)).map((r) => r.id));
    prevIdsRef.current = new Set(all.map((r) => r.id));
    if (enteringClearTimerRef.current) {
      clearTimeout(enteringClearTimerRef.current);
      enteringClearTimerRef.current = null;
    }
    if (newIds.size > 0) {
      setEnteringIds(newIds);
      if (Platform.OS === "ios" || Platform.OS === "android") {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      enteringClearTimerRef.current = setTimeout(() => setEnteringIds(new Set()), theme.motion.normal + 800);
    } else {
      setEnteringIds(new Set());
    }
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

    if (all.length === 0 && s) {
      const slot = s as { session_date: string; start_time: string; coach_id: string };
      const { data: siblings } = await supabase
        .from("training_sessions")
        .select("id")
        .eq("session_date", slot.session_date)
        .eq("start_time", slot.start_time)
        .eq("coach_id", slot.coach_id)
        .neq("id", sessionId);
      const siblingIds = ((siblings as { id: string }[] | null) ?? []).map((x) => x.id);
      if (siblingIds.length > 0) {
        const counts = await fetchActiveSignupCountsBySession(siblingIds);
        const withRoster = siblingIds.find((sid) => (counts[sid] ?? 0) > 0) ?? null;
        setDuplicateRosterSessionId(withRoster);
        onDuplicateRosterSession?.(withRoster);
      }
    }

    setLoading(false);
  }, [sessionId, onParticipantCountChange, onAttendanceStatsChange, onDuplicateRosterSession]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    // Silent: a newly-added participant animates in via `enteringIds` instead of a full skeleton flash.
    if (refreshNonce > 0) load({ silent: true });
  }, [refreshNonce, load]);

  useEffect(() => {
    return () => {
      if (enteringClearTimerRef.current) clearTimeout(enteringClearTimerRef.current);
    };
  }, []);

  function formatBillingAmountDraft(amount: number): string {
    const rounded = Math.round(amount * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  }

  async function defaultBillingAmountDraft(row: Row): Promise<string> {
    const userId = row.kind === "registered" ? row.userId : null;
    const manualParticipantId = row.kind === "manual" ? row.manualId : null;
    const cached = effectivePriceByRowId[row.id];
    if (cached != null && cached > 0) return formatBillingAmountDraft(cached);
    try {
      const price = sessionMeta
        ? await resolveRowBillingPriceIls(
            supabase,
            sessionId,
            userId,
            manualParticipantId,
            sessionMeta,
            rosterPriceByRowId[row.id] ?? null
          )
        : await fetchSessionBillingPriceIls(supabase, sessionId, userId, manualParticipantId);
      if (price <= 0) return "";
      return formatBillingAmountDraft(price);
    } catch {
      const msg = t("attendance.failedToLoadPrice");
      setLoadError(msg);
      return "";
    }
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
    setPayOpen(false);
    setPayFor(null);
    setPayPhase("method");
    setPayChosenMethod(null);
    setPayAmountDraft("");
    setPayMode("arrived");
    Keyboard.dismiss();
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
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.couldNotSave"), data?.error ?? "");
      return;
    }
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== key) return r;
        const attended =
          status === "unset" ? null : status === "arrived" ? true : false;
        return {
          ...r,
          attended,
          paymentMethod: status === "unset" ? null : (paymentMethod ?? null),
          amountPaid: status === "unset" ? null : (amountPaid ?? null),
          chargeNoShow: status === "absent" ? (chargeNoShow ?? false) : false,
        };
      })
    );
    await load({ silent: true });
    onChanged?.();
  }

  async function markAllArrived() {
    if (rows.length === 0) return;
    const todo = rows.filter((r) => r.attended !== true);
    if (todo.length === 0) return;
    showConfirm({
      title: t("attendance.markAllTitle"),
      message: t("attendance.markAllMessage").replace("{n}", String(todo.length)),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("common.ok"),
      onConfirm: () => void runMarkAll(),
    });
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
          showOk(t("common.error"), error.message);
          return;
        }
        if (!data?.ok) {
          showOk(t("common.couldNotSave"), data?.error ?? "");
          return;
        }
      }
      await load({ silent: true });
      onChanged?.();
    } finally {
      setBusyKey(null);
    }
  }

  const duplicateBanner =
    duplicateRosterSessionId != null ? (
      <Pressable
        style={({ pressed }) => [styles.duplicateBanner, pressed && { opacity: 0.92 }]}
        onPress={() => {
          const base = pathname.includes("/coach/") ? "/(app)/coach/session/" : "/(app)/manager/session/";
          router.replace(`${base}${duplicateRosterSessionId}` as never);
        }}
      >
        <Text style={[styles.duplicateBannerTxt, isRTL && styles.rtlText]}>{t("managerSession.duplicateRosterHint")}</Text>
        <Text style={styles.duplicateBannerLink}>{t("managerSession.duplicateRosterOpen")}</Text>
      </Pressable>
    ) : null;

  const skeleton = (
    <View style={styles.skeletonList}>
      <ListRowSkeleton />
      <ListRowSkeleton />
      <ListRowSkeleton />
    </View>
  );

  if (rows.length === 0) {
    return (
      <CrossfadeSwap loading={loading} skeleton={skeleton}>
        <View style={styles.emptyWrap}>
          {loadError ? (
            <Text style={[styles.loadError, isRTL && styles.rtlText]}>{loadError}</Text>
          ) : null}
          {duplicateBanner}
          <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("attendance.noActiveRegistrations")}</Text>
        </View>
      </CrossfadeSwap>
    );
  }

  return (
    <CrossfadeSwap loading={loading} skeleton={skeleton}>
    <View style={styles.list}>
      {loadError ? <Text style={[styles.loadError, isRTL && styles.rtlText]}>{loadError}</Text> : null}
      {duplicateBanner}
      {showMarkAllArrived && rows.some((r) => r.attended !== true) ? (
        <PressableScale
          style={({ pressed }) => [styles.markAll, pressed && { opacity: 0.9 }]}
          onPress={markAllArrived}
          disabled={busyKey !== null}
        >
          <Text style={styles.markAllTxt}>{t("attendance.markAllArrived")}</Text>
        </PressableScale>
      ) : null}
      {rows.map((item, rowIndex) => {
        const current: AttendanceStatus =
          item.attended === true ? "arrived" : item.attended === false ? "absent" : "unset";
        const busy = busyKey === item.id || busyKey === "__all__";
        const effectivePrice = effectivePriceByRowId[item.id] ?? 0;
        const hasRateOverride = rosterPriceByRowId[item.id] != null;
        const entering = enteringIds.has(item.id);
        return (
          <FadeSlideIn
            key={item.id}
            delay={Math.min(rowIndex, theme.motion.maxStaggerIndex) * 30}
            style={styles.card}
          >
            {entering ? <EnteringHighlight /> : null}
            <View style={[styles.nameRow, rowFlipFor(isRTL) && styles.nameRowRtl]}>
              <View style={[styles.nameBlock, rowFlipFor(isRTL) && styles.nameBlockRtl]}>
                <Text {...userContentTextProps} style={[styles.name, isRTL && styles.rtlText]} numberOfLines={1}>
                  {item.name}
                  {item.birthdayToday ? (
                    <Text style={styles.bday}>
                      {"  "}
                      <AppIcon name="gift-outline" size="sm" color={theme.colors.warning} accessibilityLabel={t("staffUsers.birthdayToday")} />
                    </Text>
                  ) : null}
                </Text>
                {item.phone ? (
                  <Text style={[styles.sub, isRTL && styles.rtlText]} numberOfLines={1}>
                    {displayLtr(item.phone)}
                  </Text>
                ) : null}
                {sessionMeta && effectivePrice > 0 ? (
                  <Text
                    style={[
                      styles.dueLine,
                      isRTL && styles.rtlText,
                      hasRateOverride && styles.dueLineCustom,
                    ]}
                    numberOfLines={2}
                  >
                    {t("managerSession.rosterSlotRateDue").replace(
                      "{amount}",
                      formatRosterIls(effectivePrice, language)
                    )}
                    {hasRateOverride ? ` · ${t("managerSession.rosterSlotRateCustomBadge")}` : ""}
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
                      {t("ui.participantAttendanceList.payment")}
                      {paymentDisplayTone(item.paymentMethod) === "unpaid"
                        ? t("ui.participantAttendanceList.unpaid")
                        : paymentMethodAttendanceLabel(item.paymentMethod, language)}
                      {item.amountPaid != null ? ` · ${displayMoney(item.amountPaid)}` : ""}
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
                      {t("ui.participantAttendanceList.noShowPayment")}
                      {paymentDisplayTone(item.paymentMethod) === "unpaid"
                        ? t("ui.participantAttendanceList.unpaid")
                        : paymentMethodAttendanceLabel(item.paymentMethod, language)}
                      {item.amountPaid != null ? ` · ${displayMoney(item.amountPaid)}` : ""}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={[styles.nameRight, rowFlipFor(isRTL) && styles.nameRightRtl]}>
                {sessionMeta ? (
                  <RosterSlotRateChip
                    sessionId={sessionId}
                    userId={item.kind === "registered" ? item.userId : null}
                    manualParticipantId={item.kind === "manual" ? item.manualId : null}
                    participantName={item.name}
                    rosterPriceIls={rosterPriceByRowId[item.id] ?? null}
                    effectivePriceIls={effectivePriceByRowId[item.id] ?? 0}
                    disabled={busy}
                    onSaved={() => {
                      void load({ silent: true });
                      onChanged?.();
                    }}
                  />
                ) : null}
                {busy ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
                {item.kind === "registered" && superUserHiddenUserIds ? (
                  (() => {
                    const isHidden = superUserHiddenUserIds.has(item.userId);
                    const toggleBusy = hideToggleBusyUserId === item.userId;
                    return (
                      <View style={[styles.hideControl, rowFlipFor(isRTL) && styles.hideControlRtl]}>
                        {isHidden ? (
                          <View style={styles.hiddenBadge}>
                            <Text style={styles.hiddenBadgeTxt}>{t("superUser.hiddenBadge")}</Text>
                          </View>
                        ) : null}
                        {onToggleHideAthlete ? (
                          toggleBusy ? (
                            <ActivityIndicator size="small" color={theme.colors.cta} />
                          ) : (
                            <IconButton
                              onPress={() => confirmToggleHideAthlete(item, isHidden)}
                              icon={isHidden ? "eye-outline" : "eye-off-outline"}
                              accessibilityLabel={t(isHidden ? "superUser.unhideAction" : "superUser.hideAction")}
                              />
                          )
                        ) : null}
                      </View>
                    );
                  })()
                ) : null}
                {onMoveParticipant && sessionNotStarted && rowCanMove(item) && !busy ? (
                  <IconButton onPress={() => openMove(item)} icon="swap-horizontal" accessibilityLabel={t("a11y.moveParticipant")} />
                ) : null}
                {item.kind === "registered" && onRemoveAthlete && !busy ? (
                  <IconButton onPress={() => confirmRemoveRegistered(item)} icon="close" variant="danger" accessibilityLabel={t("a11y.removeParticipant")} />
                ) : null}
                {item.kind === "manual" && onRemoveManualParticipant && !busy ? (
                  <IconButton onPress={() => confirmRemoveManual(item)} icon="close" variant="danger" accessibilityLabel={t("a11y.removeParticipant")} />
                ) : null}
              </View>
            </View>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("ui.participantAttendanceList.attendance")}</Text>
            <View style={[styles.seg, rowFlipFor(isRTL) && styles.segRtl]}>
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
                      ? t("ui.participantAttendanceList.notSet")
                      : st === "arrived"
                        ? t("ui.participantAttendanceList.arrived")
                        : t("ui.participantAttendanceList.absent")}
                  </Text>
                </Pressable>
              ))}
            </View>
            {current === "absent" ? (
              <View style={[styles.noShowFeeRow, rowFlipFor(isRTL) && styles.noShowFeeRowRtl]}>
                <Text style={[styles.noShowFeeLabel, isRTL && styles.rtlText]}>
                  {t("ui.participantAttendanceList.chargeNoShowFee")}
                </Text>
                <View style={[styles.noShowFeeSeg, rowFlipFor(isRTL) && styles.noShowFeeSegRtl]}>
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
                      {t("ui.participantAttendanceList.no")}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => openPaymentModal(item, "absent_penalty")}
                    style={({ pressed }) => [
                      styles.noShowFeeBtn,
                      item.chargeNoShow && styles.noShowFeeBtnOn,
                      pressed && styles.segBtnPressed,
                    ]}
                  >
                    <Text style={[styles.noShowFeeBtnTxt, item.chargeNoShow && styles.noShowFeeBtnTxtOn]}>
                      {t("ui.participantAttendanceList.yes")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </FadeSlideIn>
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
                    ? t("ui.participantAttendanceList.paymentNoShow")
                    : t("ui.participantAttendanceList.paymentMethod")}
                </Text>
                {SESSION_PAYMENT_METHOD_KEYS.map((pm) => (
                  <Pressable
                    key={pm}
                    style={({ pressed }) => [styles.payBtn, pressed && { opacity: 0.9 }]}
                    onPress={() => {
                      void goToPaymentAmountPhase(pm);
                    }}
                  >
                    <Text style={styles.payBtnTxt}>{paymentMethodAttendanceLabel(pm, language)}</Text>
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
                    {t("ui.participantAttendanceList.unpaid")}
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
                    ? t("ui.participantAttendanceList.amountPaidNoShow")
                    : t("ui.participantAttendanceList.amountPaid")}
                </Text>
                <Text style={[styles.payHint, isRTL && styles.rtlText]}>
                  {t("ui.participantAttendanceList.optionalLeaveBlankIfNotNeeded")}
                </Text>
                <TextInput
                  style={[styles.payAmountInput, isRTL && styles.payAmountInputRtl]}
                  value={payAmountDraft}
                  onChangeText={setPayAmountDraft}
                  placeholder={t("ui.participantAttendanceList.eG120")}
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
                      showOk(t("common.error"), t("attendance.invalidAmount"));
                      return;
                    }
                    closePaymentModal();
                    if (payMode === "absent_penalty") void setStatus(row, "absent", method, parsed, true);
                    else void setStatus(row, "arrived", method, parsed);
                  }}
                >
                  <Text style={styles.payBtnTxtPrimary}>{t("ui.participantAttendanceList.confirm")}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setPayPhase("method");
                    setPayChosenMethod(null);
                  }}
                  style={({ pressed }) => pressed && { opacity: 0.8 }}
                >
                  <Text style={styles.payCancel}>{t("ui.participantAttendanceList.back")}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
    </CrossfadeSwap>
  );
}

const styles = StyleSheet.create({
  skeletonList: { gap: theme.spacing.sm, marginVertical: theme.spacing.md },
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
  markAllTxt: { color: theme.colors.cta, fontWeight: "800", fontSize: 13 },
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
  name: { flex: 1, ...theme.typography.title, color: theme.colors.text },
  bday: { color: theme.colors.cta, fontWeight: "900" },
  sub: { marginTop: 2, color: theme.colors.textMuted, fontSize: 12 },
  dueLine: { marginTop: 6, fontSize: 14, fontWeight: "800", color: theme.colors.text },
  dueLineCustom: { color: theme.colors.cta },
  paymentLine: { marginTop: 6, fontSize: 13, fontWeight: "800" },
  paymentUnpaid: { color: theme.colors.error },
  paymentCash: { color: theme.colors.success },
  paymentOther: { color: "#EAB308" },
  /** 12px apart so the 44px touch areas of the row actions never overlap. */
  nameRight: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  nameRightRtl: { flexDirection: "row-reverse" },
  hideControl: { flexDirection: "row", alignItems: "center", gap: 6 },
  hideControlRtl: { flexDirection: "row-reverse" },
  hiddenBadge: {
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.errorBg,
  },
  hiddenBadgeTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 11 },
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
  segTxt: { ...theme.typography.label, color: theme.colors.textMuted },
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
  noShowFeeLabel: { flex: 1, ...theme.typography.label, color: theme.colors.textMuted },
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
  payBackdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: theme.overlay.backdrop },
  payCard: {
    width: "100%",
    maxWidth: LAYOUT.modal.dialogMaxWidth,
    alignSelf: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    zIndex: 1,
  },
  payTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  payHint: { marginTop: 6, ...theme.typography.caption, color: theme.colors.textMuted },
  payAmountInput: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...theme.typography.title,
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
  emptyWrap: { gap: 8 },
  loadError: { fontSize: 13, color: theme.colors.error, lineHeight: 18 },
  duplicateBanner: {
    padding: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    backgroundColor: "rgba(96, 165, 250, 0.12)",
    gap: 6,
  },
  duplicateBannerTxt: { fontSize: 13, color: theme.colors.text, lineHeight: 18, fontWeight: "600" },
  duplicateBannerLink: { fontSize: 13, color: theme.colors.cta, fontWeight: "800" },
});
