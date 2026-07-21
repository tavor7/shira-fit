import { useNavigation } from "@react-navigation/native";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
  ScrollView,
  Modal,
  ActivityIndicator,
} from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import type { TrainingSession } from "../../../../src/types/database";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import {
  ParticipantAttendanceList,
  type SessionAttendanceStats,
} from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { MoveParticipantSheet, type MoveParticipantTarget } from "../../../../src/components/MoveParticipantSheet";
import { SessionWhenFields } from "../../../../src/components/SessionWhenFields";
import { SessionCapacityFields } from "../../../../src/components/SessionCapacityFields";
import {
  clampSessionDuration,
  clampSessionMaxParticipants,
  isValidSessionDuration,
  isValidSessionMaxParticipants,
  normalizeSessionDurationString,
  normalizeSessionMaxString,
} from "../../../../src/lib/sessionCapacityOptions";
import { isMissingColumnError } from "../../../../src/lib/dbColumnErrors";
import { isValidISODateString, toISODateLocal } from "../../../../src/lib/isoDate";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay, formatISODateFullWithWeekdayAfter } from "../../../../src/lib/dateFormat";
import { formatSessionStartTime, hasSessionNotEnded, hasSessionNotStarted, isCancellationWithinHoursBeforeSession } from "../../../../src/lib/sessionTime";
import { useAuth } from "../../../../src/context/AuthContext";
import { sessionFormStyles as sf } from "../../../../src/components/sessionFormStyles";
import { useToast } from "../../../../src/context/ToastContext";
import { copySessionParticipantsToNewSession } from "../../../../src/lib/copySessionParticipants";
import { useDiscardChangesPrompt } from "../../../../src/hooks/useDiscardChangesPrompt";
import { useAppAlert } from "../../../../src/context/AppAlertContext";
import { useSessionPresence, type PresentStaffMember } from "../../../../src/hooks/useSessionPresence";
import { SessionPresenceBar } from "../../../../src/components/SessionPresenceBar";
import { useRealtimeRefetch } from "../../../../src/hooks/useRealtimeRefetch";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";
import { usePersistedState } from "../../../../src/hooks/usePersistedState";
import { uiDraftStorageKey } from "../../../../src/lib/uiDraftStorage";
import { replaceToManagerSessions } from "../../../../src/lib/managerSessionsRedirectLog";
import {
  deleteSessionWithSeriesScope,
  formatSessionSeriesError,
  isMissingSessionSeriesRpc,
  updateSessionWithSeriesScope,
  type SeriesScope,
} from "../../../../src/lib/sessionSeries";
import {
  SessionSeriesScopeSheet,
  type SeriesScopeChoice,
} from "../../../../src/components/SessionSeriesScopeSheet";
import { SessionSlotRateField } from "../../../../src/components/SessionSlotRateField";
import { SessionOptionsSection } from "../../../../src/components/SessionOptionsSection";
import {
  SessionCoachPickerField,
  formatCoachOptionLabel,
  type CoachOption as SessionCoachOption,
} from "../../../../src/components/SessionCoachPickerField";
import { KickboxSessionBadge } from "../../../../src/components/KickboxSessionBadge";
import {
  fetchSessionBillingPriceIls,
  parseCustomSlotPriceDraft,
  sumSessionBillingPrices,
  fetchActiveGlobalTierPrice,
} from "../../../../src/lib/sessionSlotPrice";
import { CrossfadeSwap } from "../../../../src/components/CrossfadeSwap";
import { FadeSlideIn } from "../../../../src/components/FadeSlideIn";
import { PressableScale } from "../../../../src/components/PressableScale";
import { useCountUp } from "../../../../src/hooks/useCountUp";

/** Temporary: draft write/hydrate diagnostics for manager session only. Set false to hide. */
const MANAGER_SESSION_DRAFT_DIAGNOSTICS = false;

type CoachOption = { user_id: string; full_name: string; role: string; username: string };

type EditSnapshot = {
  date: string;
  time: string;
  coachId: string;
  coachLabel: string;
  maxP: string;
  durationMin: string;
  open: boolean;
  hidden: boolean;
  isKickbox: boolean;
};

const MANAGER_SESSION_DRAFT_VERSION = 1 as const;

type ManagerSessionUiDraft = {
  v: typeof MANAGER_SESSION_DRAFT_VERSION;
  editingSession: boolean;
  editBaseline: string | null;
  addOpen: boolean;
  date: string;
  time: string;
  coachId: string;
  coachLabel: string;
  maxP: string;
  durationMin: string;
  open: boolean;
  hidden: boolean;
  isKickbox: boolean;
  undoStack: EditSnapshot[];
  dupOpen: boolean;
  dupDate: string;
  dupTime: string;
  dupIncludeParticipants: boolean;
  noteDraft: string;
  noteComposerOpen: boolean;
  editingNoteId: string | null;
  noteEditDraft: string;
};

const INITIAL_MANAGER_SESSION_DRAFT: ManagerSessionUiDraft = {
  v: MANAGER_SESSION_DRAFT_VERSION,
  editingSession: false,
  editBaseline: null,
  addOpen: false,
  date: "",
  time: "",
  coachId: "",
  coachLabel: "",
  maxP: "",
  durationMin: "",
  open: false,
  hidden: false,
  isKickbox: false,
  undoStack: [],
  dupOpen: false,
  dupDate: "",
  dupTime: "",
  dupIncludeParticipants: false,
  noteDraft: "",
  noteComposerOpen: false,
  editingNoteId: null,
  noteEditDraft: "",
};

type NoteRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: string;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

type CancellationRow = {
  id: string;
  user_id: string;
  cancelled_at: string;
  reason: string;
  charged_full_price: boolean;
  penalty_collected_ils?: number | string | null;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

type WaitlistRow = {
  user_id: string;
  requested_at: string;
  profiles: { full_name: string; phone?: string | null } | { full_name: string; phone?: string | null }[] | null;
};

/** Picker stores "Full name — role"; read-only session UI shows name only. */
function coachDisplayNameFromLabel(label: string): string {
  const raw = label.trim();
  if (!raw) return "";
  const sep = " — ";
  const i = raw.indexOf(sep);
  return i === -1 ? raw : raw.slice(0, i).trim();
}

function formatIls(n: number, language: string): string {
  const r = Math.round(n * 100) / 100;
  return language === "he" ? `${r.toLocaleString("he-IL")} ₪` : `${r.toLocaleString("en-US")} ₪`;
}

export default function ManagerSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const { language, t, isRTL } = useI18n();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const { showOk, showConfirm } = useAppAlert();
  const { user, profile, loading: authLoading } = useAuth();
  const presenceSelf: PresentStaffMember | null =
    profile && (profile.role === "coach" || profile.role === "manager")
      ? { userId: profile.user_id, name: profile.full_name, role: profile.role }
      : null;
  const othersPresent = useSessionPresence(id, presenceSelf);
  const managerSessionScreenKey = `manager-session:${String(id ?? "")}`;
  const draftStorageKey = useMemo(() => uiDraftStorageKey(user?.id, managerSessionScreenKey), [user?.id, managerSessionScreenKey]);
  const [uiDraft, setUiDraft, persistDraft] = usePersistedState(draftStorageKey, INITIAL_MANAGER_SESSION_DRAFT);
  const diagLogRef = useRef<string[]>([]);
  const [, diagBump] = useState(0);
  const loadFinishedAtRef = useRef<string | null>(null);
  const loadCountRef = useRef(0);
  const pushDiag = useCallback((line: string) => {
    if (!MANAGER_SESSION_DRAFT_DIAGNOSTICS) return;
    const ts = new Date().toISOString().slice(11, 23);
    diagLogRef.current = [`${ts} ${line}`, ...diagLogRef.current].slice(0, 30);
    diagBump((n) => n + 1);
  }, []);
  const [, setDiagPoll] = useState(0);
  useEffect(() => {
    if (!MANAGER_SESSION_DRAFT_DIAGNOSTICS) return;
    const t = setInterval(() => setDiagPoll((n) => n + 1), 400);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!MANAGER_SESSION_DRAFT_DIAGNOSTICS) return;
    pushDiag(`persistDraft.hydrated=${String(persistDraft.hydrated)}`);
  }, [persistDraft.hydrated, pushDiag]);
  const hydratedDraftApplyRef = useRef<string | null>(null);
  const draftMergedIntoLocalRef = useRef(false);
  const uiDraftRef = useRef(uiDraft);
  uiDraftRef.current = uiDraft;
  const consumeEditAfterLoadRef = useRef<ManagerSessionUiDraft | null>(null);
  const [serverFormReady, setServerFormReady] = useState(false);
  const { showToast } = useToast();
  const [participantsRev, setParticipantsRev] = useState(0);
  const [participantCount, setParticipantCount] = useState(0);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<MoveParticipantTarget | null>(null);
  const [attendanceStats, setAttendanceStats] = useState<SessionAttendanceStats>({
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
  const [tierSlotPriceIls, setTierSlotPriceIls] = useState<number | null>(null);
  const [customSlotPriceDraft, setCustomSlotPriceDraft] = useState("");
  const [customSlotPriceBusy, setCustomSlotPriceBusy] = useState(false);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [editingSession, setEditingSession] = useState(false);
  /** Snapshot when entering edit mode; used to detect unsaved changes. */
  const [editBaseline, setEditBaseline] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [coachId, setCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [isKickbox, setIsKickbox] = useState(false);
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([]);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupDate, setDupDate] = useState("");
  const [dupTime, setDupTime] = useState("");
  const [dupBusy, setDupBusy] = useState(false);
  const [dupIncludeParticipants, setDupIncludeParticipants] = useState(false);
  const [dupCoachId, setDupCoachId] = useState("");
  const [dupCoachLabel, setDupCoachLabel] = useState("");
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const [seriesScopeOpen, setSeriesScopeOpen] = useState(false);
  const [seriesScopeMode, setSeriesScopeMode] = useState<"edit" | "delete">("edit");
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);

  useEffect(() => {
    if (!editingSession) return;
    const id = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => cancelAnimationFrame(id);
  }, [editingSession]);

  useEffect(() => {
    const t = requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    return () => cancelAnimationFrame(t);
  }, [id]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [noteDraft, setNoteDraftBase] = useState("");
  const setNoteDraft = useCallback(
    (action: SetStateAction<string>) => {
      if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
        if (typeof action === "function") {
          pushDiag("setNoteDraft(SetStateAction fn)");
        } else {
          const s = String(action);
          pushDiag(
            `setNoteDraft literal len=${s.length} hasTEST123=${s.includes("TEST123")} preview=${JSON.stringify(s.slice(0, 48))}`
          );
        }
      }
      setNoteDraftBase(action);
    },
    [pushDiag]
  );
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteComposerOpen, setNoteComposerOpenBase] = useState(false);
  const setNoteComposerOpen = useCallback(
    (action: SetStateAction<boolean>) => {
      if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
        const desc = typeof action === "function" ? "SetStateAction(fn)" : String(action);
        pushDiag(`setNoteComposerOpen → ${desc}`);
      }
      setNoteComposerOpenBase(action);
    },
    [pushDiag]
  );
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const [waitlistQuickUserId, setWaitlistQuickUserId] = useState<string | null>(null);

  const editSerialized = useMemo(
    () =>
      JSON.stringify({
        date,
        time,
        coachId,
        coachLabel,
        maxP,
        durationMin,
        open,
        hidden,
        isKickbox,
        customSlotPriceDraft,
      }),
    [date, time, coachId, coachLabel, maxP, durationMin, open, hidden, isKickbox, customSlotPriceDraft]
  );

  const hasEditDirty = editingSession && editBaseline !== null && editSerialized !== editBaseline;
  const hasEditDirtyRef = useRef(false);
  hasEditDirtyRef.current = hasEditDirty;
  const allowLeaveEditRef = useRef(false);

  useEffect(() => {
    pushDiag(`effect: draftStorageKey reset → ${draftStorageKey}`);
    hydratedDraftApplyRef.current = null;
    draftMergedIntoLocalRef.current = false;
    consumeEditAfterLoadRef.current = null;
    setServerFormReady(false);
  }, [draftStorageKey, pushDiag]);

  useEffect(() => {
    if (!persistDraft.hydrated) return;
    if (hydratedDraftApplyRef.current === draftStorageKey) return;
    hydratedDraftApplyRef.current = draftStorageKey;
    const d = uiDraftRef.current;
    if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
      pushDiag(
        `effect: apply storage→form uiDraft.noteDraft=${JSON.stringify(String(d.noteDraft).slice(0, 48))} composerOpen=${String(d.noteComposerOpen)} v=${d.v}`
      );
    }
    if (d.v !== MANAGER_SESSION_DRAFT_VERSION) {
      draftMergedIntoLocalRef.current = true;
      return;
    }
    setNoteDraft(d.noteDraft);
    setNoteComposerOpen(d.noteComposerOpen);
    setEditingNoteId(d.editingNoteId);
    setNoteEditDraft(d.noteEditDraft);
    setAddOpen(d.addOpen);
    setDupOpen(d.dupOpen);
    setDupDate(d.dupDate);
    setDupTime(d.dupTime);
    setDupIncludeParticipants(d.dupIncludeParticipants);
    setUndoStack(d.undoStack);
    consumeEditAfterLoadRef.current = d.editingSession ? d : null;
    draftMergedIntoLocalRef.current = true;
  }, [persistDraft.hydrated, draftStorageKey, pushDiag, setNoteComposerOpen, setNoteDraft]);

  useEffect(() => {
    if (!session || String(session.id) !== String(id)) return;
    if (!persistDraft.hydrated) return;
    const d = consumeEditAfterLoadRef.current;
    if (!d) return;
    if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
      pushDiag("effect: consumeEditAfterLoad (draft session overlay → form fields, not note fields)");
    }
    consumeEditAfterLoadRef.current = null;
    setDate(d.date);
    setTime(d.time);
    setCoachId(d.coachId);
    setCoachLabel(d.coachLabel);
    setMaxP(normalizeSessionMaxString(d.maxP));
    setDurationMin(normalizeSessionDurationString(d.durationMin));
    setOpen(d.open);
    setHidden(d.hidden);
    setIsKickbox(d.isKickbox);
    setEditingSession(true);
    setEditBaseline(d.editBaseline);
  }, [session, id, persistDraft.hydrated, pushDiag]);

  useEffect(() => {
    if (!persistDraft.hydrated || !serverFormReady || !draftMergedIntoLocalRef.current) return;
    const next: ManagerSessionUiDraft = {
      v: MANAGER_SESSION_DRAFT_VERSION,
      editingSession,
      editBaseline,
      addOpen,
      date,
      time,
      coachId,
      coachLabel,
      maxP,
      durationMin,
      open,
      hidden,
      isKickbox,
      undoStack,
      dupOpen,
      dupDate,
      dupTime,
      dupIncludeParticipants,
      noteDraft,
      noteComposerOpen,
      editingNoteId,
      noteEditDraft,
    };
    setUiDraft((prev) => {
      const changed = JSON.stringify(prev) !== JSON.stringify(next);
      if (MANAGER_SESSION_DRAFT_DIAGNOSTICS && changed) {
        pushDiag(
          `setUiDraft(persist) noteDraft=${JSON.stringify(String(next.noteDraft).slice(0, 48))} composer=${String(next.noteComposerOpen)}`
        );
      }
      return changed ? next : prev;
    });
  }, [
    persistDraft.hydrated,
    serverFormReady,
    editingSession,
    editBaseline,
    addOpen,
    date,
    time,
    coachId,
    coachLabel,
    maxP,
    durationMin,
    open,
    hidden,
    isKickbox,
    undoStack,
    dupOpen,
    dupDate,
    dupTime,
    dupIncludeParticipants,
    noteDraft,
    noteComposerOpen,
    editingNoteId,
    noteEditDraft,
    pushDiag,
  ]);

  useEffect(() => {
    if (!editingSession) allowLeaveEditRef.current = false;
  }, [editingSession]);

  useEffect(() => {
    const cap = parseInt(maxP, 10);
    if (!Number.isFinite(cap) || cap < 1) return;
    let cancelled = false;
    const asOf =
      isValidISODateString(date.trim()) ? date.trim() : session?.session_date ?? toISODateLocal(new Date());
    void (async () => {
      try {
        const tierNum = await fetchActiveGlobalTierPrice(supabase, cap, {
          isKickbox: !!isKickbox,
          asOf,
        });
        if (cancelled) return;
        setTierSlotPriceIls(tierNum);
      } catch (error) {
        if (cancelled) return;
        showToast({
          message: t("common.error"),
          detail: error instanceof Error ? error.message : undefined,
          variant: "error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [maxP, date, isKickbox, session?.custom_slot_price_ils, session?.session_date]);

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveEditRef.current) return;
      if (!hasEditDirtyRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("sessionForm.unsavedTitle"),
        t("sessionForm.unsavedEditBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          allowLeaveEditRef.current = true;
          setEditBaseline(null);
          setEditingSession(false);
          pushDiag("clearPersisted: beforeRemove discard edit");
          void persistDraft.clearPersisted();
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t, persistDraft, pushDiag]);

  function requestCancelEdit() {
    if (!hasEditDirty) {
      setEditingSession(false);
      setEditBaseline(null);
      return;
    }
    promptDiscardChanges(
      t("sessionForm.unsavedTitle"),
      t("sessionForm.unsavedEditBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      () => {
        void load();
        setEditingSession(false);
        setEditBaseline(null);
        pushDiag("clearPersisted: requestCancelEdit discard");
        void persistDraft.clearPersisted();
      }
    );
  }

  async function quickAddWaitlistedAthlete(userId: string) {
    const sid = String(id ?? "").trim();
    if (!sid || waitlistQuickUserId) return;

    const afterOk = async () => {
      await load();
      setParticipantsRev((n) => n + 1);
    };

    setWaitlistQuickUserId(userId);
    try {
      const { data, error } = await supabase.rpc("coach_add_athlete", {
        p_session_id: sid,
        p_user_id: userId,
        p_allow_over_capacity: false,
      });
      if (error) {
        showToast({ message: t("common.error"), detail: error.message, variant: "error" });
        return;
      }
      if (data?.ok) {
        showToast({
          message: t("sessionDetail.addedToSession"),
          variant: "success",
        });
        await afterOk();
        return;
      }
      const code = String(data?.error ?? "");
      if (code === "full") {
        const title = t("sessionFull.title");
        const msg = t("sessionDetail.bumpCapacityMessage");
        const cancelLbl = t("common.cancel");
        const okLbl = t("common.continue");

        const bumpAndRetry = async () => {
          setWaitlistQuickUserId(userId);
          try {
            const parsed = parseInt(maxP, 10);
            const cur = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
            const next = cur + 1;
            const { error: upErr } = await supabase.from("training_sessions").update({ max_participants: next }).eq("id", sid);
            if (upErr) {
              showToast({ message: t("common.error"), detail: upErr.message, variant: "error" });
              return;
            }
            setMaxP(String(next));
            const r2 = await supabase.rpc("coach_add_athlete", {
              p_session_id: sid,
              p_user_id: userId,
              p_allow_over_capacity: false,
            });
            if (r2.error) {
              showToast({ message: t("common.error"), detail: r2.error.message, variant: "error" });
              return;
            }
            if (r2.data?.ok) {
              showToast({
                message: t("sessionDetail.addedToSession"),
                variant: "success",
              });
              await afterOk();
            } else {
              showOk(t("common.failed"), String(r2.data?.error ?? ""));
            }
          } finally {
            setWaitlistQuickUserId(null);
          }
        };

        showConfirm({
          title,
          message: msg,
          cancelLabel: cancelLbl,
          confirmLabel: okLbl,
          confirmVariant: "primary",
          onConfirm: () => void bumpAndRetry(),
        });
        return;
      }
      showOk(t("common.failed"), code || t("common.failed"));
    } finally {
      setWaitlistQuickUserId(null);
    }
  }

  async function loadCancellations() {
    const { data, error } = await supabase
      .from("cancellations")
      .select("id, user_id, cancelled_at, reason, charged_full_price, penalty_collected_ils, profiles(full_name)")
      .eq("session_id", id)
      .order("cancelled_at", { ascending: false });
    if (error) {
      setCancellations([]);
      return;
    }
    setCancellations((data as unknown as CancellationRow[]) ?? []);
  }

  async function setCancellationCharge(cancellationId: string, charge: boolean) {
    const { data, error } = await supabase.rpc("manager_set_cancellation_charge", {
      p_cancellation_id: cancellationId,
      p_charge: charge,
    });
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      const code = String(data?.error ?? "");
      showOk(
        t("common.failed"),
        code === "not_late_cancellation" ? t("managerSession.notLateCancellationError") : code
      );
      return;
    }
    await loadCancellations();
  }

  async function setCancellationPenaltyCollected(cancellationId: string, amount: number) {
    const { data, error } = await supabase.rpc("manager_set_cancellation_penalty_collected", {
      p_cancellation_id: cancellationId,
      p_collected_ils: amount,
    });
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.failed"), String(data?.error ?? ""));
      return;
    }
    await loadCancellations();
  }

  async function markCancellationPenaltyFull(cancellationId: string, userId: string) {
    let amount: number;
    try {
      amount = await fetchSessionBillingPriceIls(supabase, String(id), userId);
    } catch (error) {
      showOk(t("common.error"), error instanceof Error ? error.message : t("common.failed"));
      return;
    }
    if (amount <= 0) return;
    await setCancellationPenaltyCollected(cancellationId, amount);
  }

  async function loadWaitlist() {
    const { data, error } = await supabase
      .from("waitlist_requests")
      .select("user_id, requested_at, profiles(full_name, phone)")
      .eq("session_id", id)
      .order("requested_at", { ascending: true });
    if (error) {
      setWaitlist([]);
      return;
    }
    setWaitlist((data as unknown as WaitlistRow[]) ?? []);
  }

  async function load() {
    if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
      pushDiag(`load() start id=${String(id)}`);
    }
    const { data: s } = await supabase.from("training_sessions").select("*").eq("id", id).single();
    if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
      pushDiag("load() setSession + form fields from DB row");
    }
    setSession(s as TrainingSession);
    if (s) {
      setDate(s.session_date);
      setTime(s.start_time);
      setCoachId(s.coach_id);
      setMaxP(normalizeSessionMaxString(String(s.max_participants)));
      setDurationMin(normalizeSessionDurationString(String(s.duration_minutes ?? 60)));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
      setIsKickbox(!!(s as TrainingSession).is_kickbox);
      try {
        const tierNum = await fetchActiveGlobalTierPrice(supabase, s.max_participants, {
          isKickbox: !!(s as TrainingSession).is_kickbox,
          asOf: s.session_date,
        });
        setTierSlotPriceIls(tierNum);
      } catch (error) {
        showToast({
          message: t("common.error"),
          detail: error instanceof Error ? error.message : undefined,
          variant: "error",
        });
      }
      const customRaw = (s as TrainingSession).custom_slot_price_ils;
      const customNum = customRaw != null && Number.isFinite(Number(customRaw)) ? Number(customRaw) : null;
      setCustomSlotPriceDraft(customNum != null ? String(customNum) : "");
    } else {
      setTierSlotPriceIls(null);
      setCustomSlotPriceDraft("");
    }
    loadWaitlist();
    loadCancellations();
    loadNotes();
    setServerFormReady(true);
    loadCountRef.current += 1;
    loadFinishedAtRef.current = new Date().toISOString();
    if (MANAGER_SESSION_DRAFT_DIAGNOSTICS) {
      pushDiag(`load() finished #${loadCountRef.current} serverFormReady=true`);
    }
  }

  function afterParticipantsChange() {
    loadWaitlist();
    loadCancellations();
    loadNotes();
  }

  // Ref so the realtime callback below always reads the latest `editingSession` without
  // needing to resubscribe the channel every time it changes.
  const editingSessionRef = useRef(editingSession);
  editingSessionRef.current = editingSession;

  const realtimeSubs = useMemo(
    () =>
      id
        ? [
            { table: "training_sessions", filter: `id=eq.${id}` },
            { table: "session_registrations", filter: `session_id=eq.${id}` },
            { table: "cancellations", filter: `session_id=eq.${id}` },
            { table: "waitlist_requests", filter: `session_id=eq.${id}` },
            { table: "session_manual_participants", filter: `session_id=eq.${id}` },
          ]
        : [],
    [id]
  );
  useRealtimeRefetch(realtimeSubs, () => {
    // Skip re-pulling the session row (and thus the edit form's fields) while this manager is
    // mid-edit — don't clobber in-progress input just because someone else's change came in.
    if (!editingSessionRef.current) void load();
    loadWaitlist();
    loadCancellations();
    loadNotes();
    setParticipantsRev((n) => n + 1);
  });

  async function loadNotes() {
    const { data, error } = await supabase
      .from("session_notes")
      .select("id, body, author_id, created_at, profiles(full_name)")
      .eq("session_id", id)
      .order("created_at", { ascending: false });
    if (error) {
      setNotes([]);
      return;
    }
    setNotes((data as unknown as NoteRow[]) ?? []);
  }

  async function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    setNoteBusy(true);
    const { data, error } = await supabase.rpc("add_session_note", { p_session_id: id, p_body: body });
    setNoteBusy(false);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.failed"), data?.error ?? "");
      return;
    }
    setNoteDraft("");
    setNoteComposerOpen(false);
    await loadNotes();
  }

  async function updateNote(noteId: string) {
    const body = noteEditDraft.trim();
    if (!body) return;
    setNoteBusy(true);
    const { data, error } = await supabase.rpc("update_session_note", { p_note_id: noteId, p_body: body });
    setNoteBusy(false);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.failed"), String(data?.error ?? ""));
      return;
    }
    setEditingNoteId(null);
    setNoteEditDraft("");
    await loadNotes();
  }

  async function deleteNote(noteId: string) {
    const msg = t("sessionDetail.deleteNoteMessage");
    const run = async () => {
      setNoteBusy(true);
      const { data, error } = await supabase.rpc("delete_session_note", { p_note_id: noteId });
      setNoteBusy(false);
      if (error) {
        showOk(t("common.error"), error.message);
        return;
      }
      if (!data?.ok) {
        showOk(t("common.failed"), String(data?.error ?? ""));
        return;
      }
      await loadNotes();
      showToast({ message: t("sessionDetail.noteRemoved"), variant: "success" });
    };
    showConfirm({
      title: t("sessionDetail.deleteNoteTitle"),
      message: msg,
      cancelLabel: t("common.cancel"),
      confirmLabel: t("common.delete"),
      confirmVariant: "danger",
      onConfirm: () => void run(),
    });
  }

  useEffect(() => {
    if (!coachId) {
      setCoachLabel("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name, role, username")
        .eq("user_id", coachId)
        .single();
      if (cancelled || !data) return;
      setCoachLabel(formatCoachOptionLabel(data as CoachOption));
    })();
    return () => {
      cancelled = true;
    };
  }, [coachId]);

  useEffect(() => {
    load();
  }, [id]);

  function pushUndo() {
    setUndoStack((prev) => {
      const snap: EditSnapshot = { date, time, coachId, coachLabel, maxP, durationMin, open, hidden, isKickbox };
      const head = prev[prev.length - 1];
      if (
        head &&
        head.date === snap.date &&
        head.time === snap.time &&
        head.coachId === snap.coachId &&
        head.coachLabel === snap.coachLabel &&
        head.maxP === snap.maxP &&
        head.durationMin === snap.durationMin &&
        head.open === snap.open &&
        head.hidden === snap.hidden &&
        head.isKickbox === snap.isKickbox
      ) {
        return prev;
      }
      // cap stack to avoid unbounded growth
      if (prev.length >= 30) return [...prev.slice(prev.length - 29), snap];
      return [...prev, snap];
    });
  }

  function undoLast() {
    setUndoStack((prev) => {
      const snap = prev[prev.length - 1];
      if (!snap) return prev;
      setDate(snap.date);
      setTime(snap.time);
      setCoachId(snap.coachId);
      setCoachLabel(snap.coachLabel);
      setMaxP(snap.maxP);
      setDurationMin(snap.durationMin);
      setOpen(snap.open);
      setHidden(snap.hidden);
      setIsKickbox(snap.isKickbox);
      return prev.slice(0, -1);
    });
  }

  async function executeSaveWithScope(scope?: SeriesScope) {
    if (!isValidISODateString(date.trim())) {
      showOk(t("sessionDetail.invalidDateTitle"), t("sessionForm.invalidDate"));
      return;
    }
    if (!coachId) {
      showOk(t("sessionDetail.missingTrainerTitle"), t("sessionDetail.chooseTrainer"));
      return;
    }
    const parsedDuration = parseInt(durationMin.trim(), 10);
    const duration = clampSessionDuration(parsedDuration);
    if (!isValidSessionDuration(parsedDuration)) {
      showOk(t("sessionDetail.invalidDurationTitle"), t("sessionDetail.invalidDurationRange"));
      return;
    }
    const parsedMax = parseInt(maxP.trim(), 10);
    const maxParticipants = clampSessionMaxParticipants(parsedMax);
    if (!isValidSessionMaxParticipants(parsedMax)) {
      showOk(t("sessionDetail.invalidGroupSizeTitle"), t("sessionDetail.invalidGroupSizeRange"));
      return;
    }
    const parsedPrice = parseCustomSlotPriceDraft(customSlotPriceDraft);
    if (!parsedPrice.ok) {
      showOk(t("common.error"), t("managerSession.customSlotPriceInvalid"));
      return;
    }

    const sid = String(id ?? "").trim();
    const seriesScope: SeriesScope | null = session?.series_id && !session?.series_detached && scope ? scope : null;
    if (seriesScope) {
      const res = await updateSessionWithSeriesScope({
        sessionId: sid,
        scope: seriesScope,
        sessionDate: date.trim(),
        startTime: time,
        coachId,
        maxParticipants,
        durationMinutes: duration,
        isOpen: open,
        isHidden: hidden,
        isKickbox,
        customSlotPriceIls: parsedPrice.price,
      });
      if (!res.ok) {
        if (isMissingSessionSeriesRpc({ message: res.error })) {
          showOk(t("common.error"), t("session.seriesNeedsDb"));
        } else {
          showOk(t("common.error"), formatSessionSeriesError(res.error, t));
        }
        return;
      }
    } else {
      const payload = {
        session_date: date.trim(),
        start_time: time,
        coach_id: coachId,
        max_participants: maxParticipants,
        duration_minutes: duration,
        is_open_for_registration: open,
        is_hidden: hidden,
        is_kickbox: isKickbox,
      };
      const updateBody: Record<string, unknown> = { ...payload };
      let { error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid);
      let savedWithoutHidden = false;
      let savedWithoutKickbox = false;
      if (error && isMissingColumnError(error.message, "is_hidden")) {
        delete updateBody.is_hidden;
        savedWithoutHidden = true;
        ({ error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid));
      }
      if (error && isMissingColumnError(error.message, "is_kickbox")) {
        delete updateBody.is_kickbox;
        savedWithoutKickbox = true;
        ({ error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid));
      }
      if (error) {
        showOk(t("common.error"), error.message);
        return;
      }
      const priceOk = await persistCustomSlotPriceFromDraft();
      if (!priceOk) return;
      if (savedWithoutHidden || savedWithoutKickbox) {
        const parts: string[] = [];
        if (savedWithoutHidden) {
          parts.push(t("sessionDetail.hiddenNotSaved"));
        }
        if (savedWithoutKickbox) {
          parts.push(t("sessionDetail.kickboxNotSaved"));
        }
        showOk(t("sessionDetail.dbNoteTitle"), parts.join("\n"));
      }
    }

    await load();
    setEditingSession(false);
    setEditBaseline(null);
    if (seriesScope) {
      showToast({
        message: seriesScope === "future" ? t("sessionDetail.savedThisAndFuture") : t("sessionDetail.savedThisOnly"),
        variant: "success",
      });
    } else {
      showToast({ message: t("sessionDetail.savedSession"), variant: "success" });
    }
    pushDiag("clearPersisted: saveSession success");
    void persistDraft.clearPersisted();
  }

  function saveSession() {
    if (session?.series_id && !session.series_detached) {
      setSeriesScopeMode("edit");
      setSeriesScopeOpen(true);
      return;
    }
    void executeSaveWithScope();
  }

  function onSeriesScopeChosen(scope: SeriesScopeChoice) {
    setSeriesScopeOpen(false);
    if (seriesScopeMode === "delete") {
      void runDeleteWithScope(scope);
      return;
    }
    void executeSaveWithScope(scope);
  }

  async function duplicateSession() {
    const d = dupDate.trim();
    if (!isValidISODateString(d)) {
      showOk(t("sessionDetail.invalidDateTitle"), t("sessionForm.invalidDate"));
      return;
    }
    if (!dupCoachId) {
      showOk(t("sessionDetail.missingTrainerTitle"), t("sessionDetail.chooseTrainer"));
      return;
    }
    setDupBusy(true);
    const payload = {
      session_date: d,
      start_time: dupTime || time,
      coach_id: dupCoachId,
      max_participants: clampSessionMaxParticipants(parseInt(maxP.trim(), 10)),
      duration_minutes: clampSessionDuration(parseInt(durationMin.trim(), 10)),
      is_open_for_registration: false,
      is_hidden: hidden,
      is_kickbox: isKickbox,
    };
    let res = await supabase.from("training_sessions").insert(payload).select("id").maybeSingle();
    let error = res.error;
    if (error && (isMissingColumnError(error.message, "is_hidden") || isMissingColumnError(error.message, "is_kickbox"))) {
      const { is_hidden: _h, is_kickbox: _k, ...rest } = payload;
      res = await supabase.from("training_sessions").insert(rest).select("id").maybeSingle();
      error = res.error;
    }
    if (error) {
      setDupBusy(false);
      showOk(t("common.error"), error.message);
      return;
    }
    const newId = (res.data as { id?: string } | null)?.id;
    if (newId && dupIncludeParticipants) {
      const errs = await copySessionParticipantsToNewSession(String(id), newId);
      if (errs.length > 0) {
        showToast({
          message: t("sessionDetail.sessionCopiedPartialFail"),
          detail: errs.slice(0, 8).join("\n"),
          variant: "error",
        });
      }
    }
    setDupBusy(false);
    setDupOpen(false);
    pushDiag("clearPersisted: duplicateSession success");
    void persistDraft.clearPersisted();
    if (newId) router.push(`/(app)/manager/session/${newId}`);
  }

  function openDuplicateModal() {
    setDupDate(date);
    setDupTime(time);
    setDupIncludeParticipants(false);
    setDupCoachId(coachId);
    setDupCoachLabel(coachLabel);
    setDupOpen(true);
  }

  function selectDupCoach(opt: SessionCoachOption) {
    setDupCoachId(opt.user_id);
    setDupCoachLabel(formatCoachOptionLabel(opt));
  }

  async function runDeleteWithScope(scope?: SeriesScope) {
    const sid = String(id ?? "").trim();
    if (!sid) return;
    setDeleteSessionBusy(true);

    const seriesScope: SeriesScope | null = session?.series_id
      ? scope === "future" && !session.series_detached
        ? "future"
        : "this"
      : null;
    if (seriesScope) {
      const res = await deleteSessionWithSeriesScope(sid, seriesScope);
      setDeleteSessionBusy(false);
      if (!res.ok) {
        if (isMissingSessionSeriesRpc({ message: res.error })) {
          showOk(t("common.error"), t("session.seriesNeedsDb"));
        } else {
          showOk(t("common.error"), res.error ?? "");
        }
        return;
      }
    } else {
      const { error } = await supabase.from("training_sessions").delete().eq("id", sid);
      setDeleteSessionBusy(false);
      if (error) {
        showOk(t("common.error"), error.message);
        return;
      }
    }

    if (seriesScope) {
      showToast({
        message: seriesScope === "future" ? t("sessionDetail.deletedThisAndFuture") : t("sessionDetail.deletedThisOnly"),
        variant: "success",
      });
    } else {
      showToast({ message: t("sessionDetail.deletedSession"), variant: "success" });
    }

    pushDiag("clearPersisted: runDeleteSession success");
    void persistDraft.clearPersisted();
    replaceToManagerSessions("app/(app)/manager/session/[id].tsx", "delete_session_success", {
      authLoading,
      authUserId: user?.id ?? null,
      profileRole: profile?.role ?? null,
      routeSessionId: sid,
    });
  }

  function requestDeleteSession() {
    if (session?.series_id && !session.series_detached) {
      setSeriesScopeMode("delete");
      setSeriesScopeOpen(true);
      return;
    }
    showConfirm({
      title: t("sessionDetail.deleteSessionConfirmTitle"),
      message: t("sessionDetail.deleteSessionConfirmMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("common.delete"),
      confirmVariant: "danger",
      onConfirm: () => void runDeleteWithScope(session?.series_id ? "this" : undefined),
    });
  }

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("manager_remove_athlete", {
      p_session_id: id,
      p_user_id: userId,
    });
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) {
      load();
      setParticipantsRev((n) => n + 1);
    } else showOk(t("common.failed"), data?.error ?? "");
  }

  const handleParticipantCountChange = useCallback((n: number) => {
    setParticipantCount(n);
  }, []);

  const handleAttendanceStatsChange = useCallback((s: SessionAttendanceStats) => {
    const y = scrollYRef.current;
    setAttendanceStats(s);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y, animated: false });
    });
  }, []);

  async function removeManual(manualId: string) {
    const { data, error } = await supabase.rpc("remove_manual_participant_from_session", {
      p_session_id: id,
      p_manual_participant_id: manualId,
    });
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) {
      load();
      setParticipantsRev((n) => n + 1);
    } else showOk(t("common.failed"), data?.error ?? "");
  }

  async function persistCustomSlotPriceFromDraft(clearOnly = false): Promise<boolean> {
    const parsed = clearOnly ? { ok: true as const, price: null } : parseCustomSlotPriceDraft(customSlotPriceDraft);
    if (!parsed.ok) {
      showOk(t("common.error"), t("managerSession.customSlotPriceInvalid"));
      return false;
    }
    const { data, error } = await supabase.rpc("staff_set_session_custom_slot_price", {
      p_session_id: id,
      p_price_ils: parsed.price,
    });
    if (error) {
      showOk(t("common.error"), error.message);
      return false;
    }
    if (!data?.ok) {
      showOk(t("common.failed"), String(data?.error ?? ""));
      return false;
    }
    return true;
  }

  async function saveCustomSlotPrice(clearOnly = false) {
    if (customSlotPriceBusy) return;
    setCustomSlotPriceBusy(true);
    const ok = await persistCustomSlotPriceFromDraft(clearOnly);
    setCustomSlotPriceBusy(false);
    if (!ok) return;
    await load();
    showToast({
      message: clearOnly ? t("managerSession.usingDefaultTierRate") : t("managerSession.sessionRateSaved"),
    });
  }

  const sessionHasCustomSlotPrice =
    session?.custom_slot_price_ils != null && Number.isFinite(Number(session.custom_slot_price_ils));

  const [extraFeeSummary, setExtraFeeSummary] = useState({
    lateExpected: null as number | null,
    lateCollected: 0,
    lateChargedCount: 0,
    nsExpected: null as number | null,
    nsCollected: 0,
    nsCount: 0,
    hasAny: false,
  });

  useEffect(() => {
    if (!session || !id) {
      setExtraFeeSummary({
        lateExpected: null,
        lateCollected: 0,
        lateChargedCount: 0,
        nsExpected: null,
        nsCollected: 0,
        nsCount: 0,
        hasAny: false,
      });
      return;
    }
    let cancelled = false;
    const lateCharged = cancellations.filter(
      (c) =>
        c.charged_full_price === true &&
        isCancellationWithinHoursBeforeSession(session.session_date, session.start_time, c.cancelled_at, 12)
    );
    let lateCollected = 0;
    for (const c of lateCharged) {
      const p = Number(c.penalty_collected_ils ?? 0);
      if (Number.isFinite(p)) lateCollected += p;
    }
    const nsCount = attendanceStats.noShowChargedCount;
    const nsCollected = attendanceStats.noShowCollectedIls;

    (async () => {
      let lateExpected: number | null = null;
      if (lateCharged.length > 0) {
        lateExpected = await sumSessionBillingPrices(
          supabase,
          String(id),
          lateCharged.map((c) => ({ userId: c.user_id }))
        );
      }
      let nsExpected: number | null = null;
      if (nsCount > 0) {
        const [{ data: appNs }, { data: manNs }] = await Promise.all([
          supabase
            .from("session_registrations")
            .select("user_id")
            .eq("session_id", id)
            .eq("status", "active")
            .eq("attended", false)
            .eq("charge_no_show", true),
          supabase
            .from("session_manual_participants")
            .select("manual_participant_id")
            .eq("session_id", id)
            .eq("attended", false)
            .eq("charge_no_show", true),
        ]);
        if (cancelled) return;
        const payees = [
          ...((appNs as { user_id: string }[] | null) ?? []).map((r) => ({ userId: r.user_id })),
          ...((manNs as { manual_participant_id: string }[] | null) ?? []).map((r) => ({
            userId: null as string | null,
            manualParticipantId: r.manual_participant_id,
          })),
        ];
        nsExpected = await sumSessionBillingPrices(supabase, String(id), payees);
      }
      if (cancelled) return;
      setExtraFeeSummary({
        lateExpected,
        lateCollected,
        lateChargedCount: lateCharged.length,
        nsExpected,
        nsCollected,
        nsCount,
        hasAny: lateCharged.length > 0 || nsCount > 0,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    session,
    id,
    cancellations,
    attendanceStats.noShowChargedCount,
    attendanceStats.noShowCollectedIls,
    participantsRev,
  ]);

  const arrivedDisplay = useCountUp(attendanceStats.arrived);
  const registeredDisplay = useCountUp(attendanceStats.registered);
  const totalPaidDisplay = useCountUp(attendanceStats.totalPaidIls);
  const expectedPaymentsDisplay = useCountUp(attendanceStats.expectedPaymentsIls);
  const withPaymentMethodDisplay = useCountUp(attendanceStats.withPaymentMethod);
  const participantCountDisplay = useCountUp(participantCount);

  if (!session)
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}>
        <Stack.Screen options={{ title: t("screen.managerSession") }} />
        <Text style={[styles.loading, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
    );

  const durationMinutesForEnded = clampSessionDuration(parseInt(durationMin.trim(), 10));
  const sessionHasEnded = !hasSessionNotEnded(date, time, durationMinutesForEnded);
  const sessionCanMoveParticipants = hasSessionNotStarted(date, time);
  const parsedMaxCap = parseInt(maxP.trim(), 10);
  const maxCap = Number.isFinite(parsedMaxCap)
    ? clampSessionMaxParticipants(parsedMaxCap)
    : clampSessionMaxParticipants(session.max_participants);
  const coachNameOnly = coachDisplayNameFromLabel(coachLabel);
  const arrivalRatePct =
    attendanceStats.registered > 0
      ? Math.round((attendanceStats.arrived / attendanceStats.registered) * 100)
      : 0;

  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerSession") }} />
      <View style={styles.root}>
        <ScrollView
          ref={scrollRef}
          style={styles.screen}
          contentContainerStyle={styles.content}
          onScroll={(e) => {
            scrollYRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
      <SessionPresenceBar others={othersPresent} />
      <CrossfadeSwap
        loading={editingSession}
        skeleton={
        <View style={styles.editBlock}>
          <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={sf.cardTitle}>{t("sessionDetail.when")}</Text>
            <SessionWhenFields
              date={date}
              time={time}
              onDateChange={(v) => {
                pushUndo();
                setDate(v);
              }}
              onTimeChange={(v) => {
                pushUndo();
                setTime(v);
              }}
              dateLabel={t("sessionForm.sessionDate")}
              timeLabel={t("sessionForm.startTime")}
            />
          </View>

          <View style={sf.card}>
            <SessionCoachPickerField
              coachId={coachId}
              coachLabel={coachLabel}
              onSelect={(opt) => {
                pushUndo();
                setCoachId(opt.user_id);
                setCoachLabel(formatCoachOptionLabel(opt));
              }}
            />
          </View>

          <View style={sf.card}>
            <Text style={sf.cardTitle}>{t("sessionForm.capacity")}</Text>
            <SessionCapacityFields
              duration={durationMin}
              max={maxP}
              onDurationChange={(v) => {
                pushUndo();
                setDurationMin(v);
              }}
              onMaxChange={(v) => {
                pushUndo();
                setMaxP(v);
              }}
              durationLabel={t("sessionForm.lengthMin")}
              maxLabel={t("sessionForm.maxParticipants")}
            />
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.toggleTextRtl]}>{t("session.optionsTitle")}</Text>
            <View style={styles.optionsPanel}>
            <SessionOptionsSection
            embedded
            isRTL={isRTL}
            options={[
              {
                key: "open",
                label: t("session.openRegistration"),
                value: open,
                onValueChange: (v) => {
                  pushUndo();
                  setOpen(v);
                },
                tone: "open",
              },
              {
                key: "hidden",
                label: t("session.hiddenStaffOnly"),
                value: hidden,
                onValueChange: (v) => {
                  pushUndo();
                  setHidden(v);
                },
                tone: "hidden",
              },
              {
                key: "kickbox",
                label: t("session.kickboxSession"),
                value: isKickbox,
                onValueChange: (v) => {
                  pushUndo();
                  setIsKickbox(v);
                },
                tone: "kickbox",
              },
            ]}
            />
            </View>
          </View>

          <SessionSlotRateField
            layout="form"
            value={customSlotPriceDraft}
            onChangeValue={setCustomSlotPriceDraft}
            tierPriceIls={tierSlotPriceIls}
            hasCustomOnServer={sessionHasCustomSlotPrice}
            serverCustomPriceIls={session?.custom_slot_price_ils ?? null}
            onClear={sessionHasCustomSlotPrice ? () => setCustomSlotPriceDraft("") : undefined}
          />

          <View style={sf.card}>
            <View style={sf.toggleStack}>
              <Pressable
                onPress={undoLast}
                disabled={undoStack.length === 0}
                style={({ pressed }) => [
                  styles.undoBtn,
                  pressed && undoStack.length > 0 && { opacity: 0.85 },
                  undoStack.length === 0 && { opacity: 0.45 },
                ]}
              >
                <Text style={styles.undoBtnTxt}>{t("sessionDetail.undoLastChange")}</Text>
              </Pressable>
              <PrimaryButton label={t("common.save")} onPress={saveSession} />
              <Pressable onPress={requestCancelEdit} style={({ pressed }) => [styles.cancelEdit, pressed && { opacity: 0.85 }]}>
                <Text style={styles.cancelEditTxt}>{t("common.cancel")}</Text>
              </Pressable>
            </View>
          </View>
          </View>
        </View>
        }
      >
        <View style={styles.summaryCard}>
          <View style={[styles.summaryTitleRow, isRTL && styles.summaryTitleRowRtl]}>
            <Text style={[styles.summaryTitle, isRTL && styles.rtlText]}>{t("sessionDetail.session")}</Text>
            {session.series_id && !session.series_detached ? (
              <View style={styles.seriesBadge}>
                <Text style={styles.seriesBadgeTxt}>{t("session.seriesBadge")}</Text>
              </View>
            ) : null}
          </View>
          {isKickbox ? (
            <View style={styles.summaryKickboxBadge}>
              <KickboxSessionBadge isRTL={isRTL} />
            </View>
          ) : null}
          <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>
            {formatISODateFullWithWeekdayAfter(date, language)} · {formatSessionStartTime(time)} · {durationMin}{" "}
            {t("sessionDetail.durationMinAbbr")}
          </Text>
          <Text style={[styles.summaryCoachLine, isRTL && styles.rtlText]}>
            {t("managerSession.coachHeading")}:{" "}
            {coachNameOnly.length > 0 ? coachNameOnly : t("managerSession.noTrainerAssigned")}
          </Text>
          {sessionHasEnded ? (
            <View style={styles.summaryEndedRow} accessibilityLiveRegion="polite">
              <Text style={[styles.summaryEndedText, isRTL && styles.rtlText]}>{t("managerSession.sessionEnded")}</Text>
            </View>
          ) : null}
          <Text style={[styles.summaryMeta, isRTL && styles.rtlText]}>
            {t("sessionDetail.openLabel")}
            {open ? t("common.yes") : t("common.no")}
            {" · "}
            {t("sessionDetail.hiddenLabel")}
            {hidden ? t("common.yes") : t("common.no")}
          </Text>
          {sessionHasEnded ? (
            <View style={styles.trainingSummaryBox}>
              <Text style={[styles.trainingSummaryTitle, isRTL && styles.rtlText]}>
                {t("managerSession.trainingSummaryTitle")}
              </Text>
              {attendanceStats.registered === 0 ? (
                <Text style={[styles.summaryEmptyNote, isRTL && styles.rtlText]}>
                  {t("managerSession.summaryNoRegistrations")}
                </Text>
              ) : (
                <View style={[styles.summaryTilesRow, isRTL && styles.summaryTilesRowRtl]}>
                  <View style={[styles.summaryTile, isRTL && styles.summaryTileRtl]}>
                    <Text style={[styles.summaryTileLabel, isRTL && styles.rtlText]}>
                      {t("managerSession.summaryTileAttendance")}
                    </Text>
                    <Text style={[styles.summaryTileHero, isRTL && styles.rtlText]} accessibilityRole="header">
                      {t("managerSession.summaryAttendanceFraction")
                        .replace("{arrived}", String(Math.round(arrivedDisplay)))
                        .replace("{registered}", String(Math.round(registeredDisplay)))}
                    </Text>
                    <Text style={[styles.summaryTileHint, isRTL && styles.rtlText]}>
                      {t("managerSession.summaryAttendanceSub")
                        .replace("{pct}", String(arrivalRatePct))
                        .replace("{capacity}", String(maxCap))}
                    </Text>
                  </View>
                  <View style={[styles.summaryTile, isRTL && styles.summaryTileRtl]}>
                    <Text style={[styles.summaryTileLabel, isRTL && styles.rtlText]}>
                      {t("managerSession.summaryTilePayments")}
                    </Text>
                    <Text style={[styles.summaryTileHero, isRTL && styles.rtlText]} accessibilityRole="header">
                      {attendanceStats.expectedPaymentSlots > 0
                        ? `${formatIls(totalPaidDisplay, language)} / ${formatIls(expectedPaymentsDisplay, language)}`
                        : formatIls(totalPaidDisplay, language)}
                    </Text>
                    <Text style={[styles.summaryTileHint, isRTL && styles.rtlText]}>
                      {attendanceStats.expectedPaymentSlots > 0
                        ? attendanceStats.totalPaidIls >= attendanceStats.expectedPaymentsIls
                          ? t("managerSession.summaryPaymentsFullyCollected").replace(
                              "{expected}",
                              formatIls(attendanceStats.expectedPaymentsIls, language)
                            )
                          : t("managerSession.summaryPaymentsShouldCollect")
                              .replace("{expected}", formatIls(attendanceStats.expectedPaymentsIls, language))
                              .replace("{collected}", formatIls(attendanceStats.totalPaidIls, language))
                        : attendanceStats.totalPaidIls > 0
                          ? t("managerSession.summaryPaymentsSubRecorded")
                              .replace("{n}", String(Math.round(withPaymentMethodDisplay)))
                              .replace("{total}", String(Math.round(registeredDisplay)))
                          : attendanceStats.withPaymentMethod > 0
                            ? t("managerSession.summaryPaymentsSubMethodsOnly").replace(
                                "{n}",
                                String(Math.round(withPaymentMethodDisplay))
                              )
                            : t("managerSession.summaryPaymentsSubNone")}
                    </Text>
                  </View>
                </View>
              )}
              {sessionHasEnded && extraFeeSummary.hasAny ? (
                <View style={[styles.summaryFeesBox, isRTL && styles.summaryTileRtl]}>
                  <Text style={[styles.summaryTileLabel, isRTL && styles.rtlText]}>
                    {t("managerSession.summaryFeesTitle")}
                  </Text>
                  <Text style={[styles.summaryTileHint, isRTL && styles.rtlText]}>
                    {extraFeeSummary.lateChargedCount > 0
                      ? t("managerSession.summaryFeesLate")
                          .replace("{n}", String(extraFeeSummary.lateChargedCount))
                          .replace(
                            "{expected}",
                            extraFeeSummary.lateExpected != null
                              ? formatIls(extraFeeSummary.lateExpected, language)
                              : "—"
                          )
                          .replace("{collected}", formatIls(extraFeeSummary.lateCollected, language))
                      : ""}
                    {extraFeeSummary.lateChargedCount > 0 && extraFeeSummary.nsCount > 0 ? " · " : ""}
                    {extraFeeSummary.nsCount > 0
                      ? t("managerSession.summaryFeesNoShow")
                          .replace("{n}", String(extraFeeSummary.nsCount))
                          .replace(
                            "{expected}",
                            extraFeeSummary.nsExpected != null
                              ? formatIls(extraFeeSummary.nsExpected, language)
                              : "—"
                          )
                          .replace("{collected}", formatIls(extraFeeSummary.nsCollected, language))
                      : ""}
                  </Text>
                </View>
              ) : null}
              {cancellations.length > 0 || waitlist.length > 0 ? (
                <Text style={[styles.summaryFootnote, isRTL && styles.rtlText]}>
                  {[
                    cancellations.length > 0
                      ? t("managerSession.summaryCancellationsShort").replace("{n}", String(cancellations.length))
                      : null,
                    waitlist.length > 0
                      ? t("managerSession.summaryWaitlistShort").replace("{n}", String(waitlist.length))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </CrossfadeSwap>

      <Modal visible={dupOpen} transparent animationType="fade" onRequestClose={() => (dupBusy ? null : setDupOpen(false))}>
        <View style={styles.dupBackdrop}>
          <Pressable style={styles.dupBackdropTouch} onPress={() => (dupBusy ? null : setDupOpen(false))} />
          <View style={styles.dupCard}>
            <Text style={[styles.dupTitle, isRTL && styles.rtlText]}>{t("sessionDetail.duplicateSession")}</Text>
            <SessionWhenFields
              date={dupDate}
              time={dupTime}
              onDateChange={setDupDate}
              onTimeChange={setDupTime}
              dateLabel={t("sessionDetail.newDate")}
              timeLabel={t("sessionDetail.newTime")}
            />
            <SessionCoachPickerField
              coachId={dupCoachId}
              coachLabel={dupCoachLabel}
              onSelect={selectDupCoach}
              disabled={dupBusy}
            />
            <Text style={[styles.dupSectionLabel, isRTL && styles.rtlText]}>
              {t("sessionDetail.participants")}
            </Text>
            <View style={[styles.dupChoiceRow, isRTL && styles.dupChoiceRowRtl]}>
              <Pressable
                style={({ pressed }) => [
                  styles.dupChoice,
                  !dupIncludeParticipants && styles.dupChoiceOn,
                  pressed && { opacity: 0.9 },
                  dupBusy && { opacity: 0.5 },
                ]}
                onPress={() => !dupBusy && setDupIncludeParticipants(false)}
                disabled={dupBusy}
              >
                <Text style={[styles.dupChoiceTxt, !dupIncludeParticipants && styles.dupChoiceTxtOn, isRTL && styles.rtlText]}>
                  {t("sessionDetail.withoutParticipants")}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.dupChoice,
                  dupIncludeParticipants && styles.dupChoiceOn,
                  pressed && { opacity: 0.9 },
                  dupBusy && { opacity: 0.5 },
                ]}
                onPress={() => !dupBusy && setDupIncludeParticipants(true)}
                disabled={dupBusy}
              >
                <Text style={[styles.dupChoiceTxt, dupIncludeParticipants && styles.dupChoiceTxtOn, isRTL && styles.rtlText]}>
                  {t("sessionDetail.withSameRoster")}
                </Text>
              </Pressable>
            </View>
            <View style={styles.editSpacer} />
            <PrimaryButton
              label={t("sessionDetail.createCopy")}
              onPress={() => void duplicateSession()}
              loading={dupBusy}
              loadingLabel={t("common.loading")}
            />
            <Pressable style={({ pressed }) => [styles.dupCancel, pressed && { opacity: 0.85 }]} onPress={() => (dupBusy ? null : setDupOpen(false))}>
              <Text style={styles.dupCancelTxt}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Text style={[styles.h, isRTL && styles.rtlText]}>
        {t("sessionDetail.participantsAttendance")}
        <Text style={styles.hMuted}>
          {" "}
          ({Math.round(participantCountDisplay)}/{maxCap})
        </Text>
      </Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={afterParticipantsChange}
        onParticipantCountChange={handleParticipantCountChange}
        onAttendanceStatsChange={handleAttendanceStatsChange}
        onRemoveAthlete={removeAthlete}
        onRemoveManualParticipant={removeManual}
        onMoveParticipant={
          sessionCanMoveParticipants
            ? (target) => {
                setMoveTarget(target);
                setMoveOpen(true);
              }
            : undefined
        }
      />

      <PrimaryButton
        label={t("sessionDetail.addParticipant")}
        onPress={() => setAddOpen(true)}
        variant="ghost"
      />

      <Text style={[styles.h, isRTL && styles.rtlText]}>{t("sessionDetail.waitlist")}</Text>
      {waitlist.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.none")}</Text>
      ) : (
        waitlist.map((item, index) => {
          const p = item.profiles ? (Array.isArray(item.profiles) ? item.profiles[0] : item.profiles) : null;
          const name = String(p?.full_name ?? item.user_id);
          const phone = String(p?.phone ?? "").trim();
          const busy = waitlistQuickUserId === item.user_id;
          return (
            <FadeSlideIn key={item.user_id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={styles.waitCard}>
              <View style={[styles.waitCardRow, isRTL && styles.waitCardRowRtl]}>
                <View style={styles.waitCardMain}>
                  <Text style={[styles.waitName, isRTL && styles.rtlText]}>{name}</Text>
                  {phone ? <Text style={[styles.waitMeta, isRTL && styles.rtlText]}>{phone}</Text> : null}
                  <Text style={[styles.waitMeta, isRTL && styles.rtlText]}>
                    {formatDateTimeForDisplay(item.requested_at, language)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void quickAddWaitlistedAthlete(item.user_id)}
                  disabled={!!waitlistQuickUserId}
                  style={({ pressed }) => [
                    styles.waitQuickBtn,
                    pressed && { opacity: 0.88 },
                    busy && { opacity: 0.65 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("sessionDetail.quickAddA11y")}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.colors.ctaText} />
                  ) : (
                    <Text style={styles.waitQuickBtnTxt}>{t("common.add")}</Text>
                  )}
                </Pressable>
              </View>
              </View>
            </FadeSlideIn>
          );
        })
      )}

      <Text style={[styles.h, isRTL && styles.rtlText]}>{t("sessionDetail.cancellations")}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.none")}</Text>
      ) : (
        cancellations.map((c, index) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          const sched = session
            ? isCancellationWithinHoursBeforeSession(session.session_date, session.start_time, c.cancelled_at, 12)
            : false;
          const feeCharged = c.charged_full_price === true;
          const penaltyNum = Number(c.penalty_collected_ils ?? 0);
          const collected = Number.isFinite(penaltyNum) ? penaltyNum : 0;
          return (
            <FadeSlideIn key={c.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
            <View style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>{t("sessionDetail.reasonPrefix")}{c.reason}</Text>
              {sched ? (
                <>
                  <Text style={styles.chargeWarn}>
                    {t("managerSession.lateCancelBadge")}
                  </Text>
                  <View style={[styles.cancelChargeRow, isRTL && styles.cancelChargeRowRtl]}>
                    <Pressable
                      onPress={() => void setCancellationCharge(c.id, false)}
                      style={({ pressed }) => [
                        styles.cancelChargeBtn,
                        !feeCharged && styles.cancelChargeBtnOn,
                        pressed && { opacity: 0.88 },
                      ]}
                    >
                      <Text style={[styles.cancelChargeBtnTxt, !feeCharged && styles.cancelChargeBtnTxtOn]}>
                        {t("managerSession.cancelChargeWaive")}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void setCancellationCharge(c.id, true)}
                      style={({ pressed }) => [
                        styles.cancelChargeBtn,
                        feeCharged && styles.cancelChargeBtnOn,
                        pressed && { opacity: 0.88 },
                      ]}
                    >
                      <Text style={[styles.cancelChargeBtnTxt, feeCharged && styles.cancelChargeBtnTxtOn]}>
                        {t("managerSession.cancelChargeApply")}
                      </Text>
                    </Pressable>
                  </View>
                  {feeCharged ? (
                    <View style={[styles.cancelPenaltyRow, isRTL && styles.cancelPenaltyRowRtl]}>
                      <Text style={styles.cancelMeta}>
                        {t("managerSession.penaltyCollected").replace("{amount}", formatIls(collected, language))}
                      </Text>
                      <Pressable
                        onPress={() => void markCancellationPenaltyFull(c.id, c.user_id)}
                        style={({ pressed }) => [styles.penaltyMarkBtn, pressed && { opacity: 0.88 }]}
                      >
                        <Text style={styles.penaltyMarkBtnTxt}>{t("managerSession.penaltyMarkFull")}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>
            </FadeSlideIn>
          );
        })
      )}


      <Text style={[styles.h, isRTL && styles.rtlText]}>{t("sessionDetail.notes")}</Text>
      <View style={styles.notesCard}>
        {!noteComposerOpen ? (
          <Pressable
            onPress={() => {
              setEditingNoteId(null);
              setNoteEditDraft("");
              setNoteComposerOpen(true);
            }}
            style={({ pressed }) => [styles.noteCollapsedTrigger, pressed && { opacity: 0.88 }]}
            accessibilityRole="button"
          >
            <Text style={[styles.noteCollapsedTriggerText, isRTL && styles.rtlText]}>
              {t("sessionDetail.tapAddNote")}
            </Text>
          </Pressable>
        ) : (
          <View>
            <TextInput
              style={[styles.noteInput, isRTL && styles.noteInputRtl]}
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder={t("sessionDetail.addNotePlaceholder")}
              placeholderTextColor={theme.colors.placeholderOnLight}
              multiline
              autoFocus
            />
            <View style={[styles.noteComposerActions, isRTL && styles.noteComposerActionsRtl]}>
              <Pressable
                onPress={() => {
                  setNoteComposerOpen(false);
                  setNoteDraft("");
                }}
                style={({ pressed }) => [styles.noteCancelBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.noteCancelBtnTxt}>{t("common.close")}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.noteBtn,
                  styles.noteBtnInline,
                  pressed && { opacity: 0.9 },
                  (noteBusy || !noteDraft.trim()) && { opacity: 0.5 },
                ]}
                onPress={() => void addNote()}
                disabled={noteBusy || !noteDraft.trim()}
              >
                {noteBusy ? (
                  <ActivityIndicator color={theme.colors.ctaText} />
                ) : (
                  <Text style={styles.noteBtnTxt}>{t("sessionDetail.saveNote")}</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}

        {notes.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtlText, styles.noteListHint]}>
            {t("sessionDetail.noSavedNotes")}
          </Text>
        ) : (
          <View style={styles.noteList}>
            {notes.map((n, index) => {
              const p = n.profiles ? (Array.isArray(n.profiles) ? n.profiles[0] : n.profiles) : null;
              const name = p?.full_name ?? n.author_id;
              const canDelete = (profile?.role === "manager") || (!!user?.id && user.id === n.author_id);
              const isEditing = editingNoteId === n.id;
              return (
                <FadeSlideIn key={n.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
                <View style={styles.noteRow}>
                  <Text style={[styles.noteMeta, isRTL && styles.rtlText]}>
                    {name} · {formatDateTimeForDisplay(n.created_at, language)}
                  </Text>
                  {isEditing ? (
                    <>
                      <TextInput
                        style={[styles.noteInput, isRTL && styles.noteInputRtl, styles.noteEditInput]}
                        value={noteEditDraft}
                        onChangeText={setNoteEditDraft}
                        placeholderTextColor={theme.colors.placeholderOnLight}
                        multiline
                        autoFocus
                      />
                      <View style={[styles.noteEditActions, isRTL && styles.noteEditActionsRtl]}>
                        <Pressable
                          onPress={() => {
                            setEditingNoteId(null);
                            setNoteEditDraft("");
                          }}
                          style={({ pressed }) => [styles.noteCancelBtn, pressed && { opacity: 0.85 }]}
                        >
                          <Text style={styles.noteCancelBtnTxt}>{t("common.cancel")}</Text>
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [
                            styles.noteBtn,
                            styles.noteBtnInline,
                            pressed && { opacity: 0.9 },
                            (noteBusy || !noteEditDraft.trim()) && { opacity: 0.5 },
                          ]}
                          onPress={() => void updateNote(n.id)}
                          disabled={noteBusy || !noteEditDraft.trim()}
                        >
                          {noteBusy ? (
                            <ActivityIndicator color={theme.colors.ctaText} />
                          ) : (
                            <Text style={styles.noteBtnTxt}>{t("common.save")}</Text>
                          )}
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <Text style={[styles.noteBody, isRTL && styles.rtlText]}>{n.body}</Text>
                  )}
                  {!isEditing && canDelete ? (
                    <View style={[styles.noteRowActions, isRTL && styles.noteRowActionsRtl]}>
                      <PressableScale
                        onPress={() => {
                          setNoteComposerOpen(false);
                          setNoteDraft("");
                          setEditingNoteId(n.id);
                          setNoteEditDraft(n.body);
                        }}
                        {...(Platform.OS === "web"
                          ? ({
                              onClick: () => {
                                setNoteComposerOpen(false);
                                setNoteDraft("");
                                setEditingNoteId(n.id);
                                setNoteEditDraft(n.body);
                              },
                            } as any)
                          : null)}
                        style={[styles.noteEditBtn, Platform.OS === "web" && styles.noteDeleteWeb]}
                        accessibilityRole="button"
                      >
                        <Text style={styles.noteEditBtnTxt}>{t("common.edit")}</Text>
                      </PressableScale>
                      <PressableScale
                        onPress={() => void deleteNote(n.id)}
                        {...(Platform.OS === "web" ? ({ onClick: () => void deleteNote(n.id) } as any) : null)}
                        style={[styles.noteDelete, Platform.OS === "web" && styles.noteDeleteWeb]}
                        accessibilityRole="button"
                      >
                        <Text style={styles.noteDeleteTxt}>{t("common.delete")}</Text>
                      </PressableScale>
                    </View>
                  ) : null}
                </View>
                </FadeSlideIn>
              );
            })}
          </View>
        )}
      </View>

      {!editingSession ? (
        <SessionSlotRateField
          value={customSlotPriceDraft}
          onChangeValue={setCustomSlotPriceDraft}
          tierPriceIls={tierSlotPriceIls}
          hasCustomOnServer={sessionHasCustomSlotPrice}
          serverCustomPriceIls={session?.custom_slot_price_ils ?? null}
          onApply={() => void saveCustomSlotPrice(false)}
          onClear={() => void saveCustomSlotPrice(true)}
          applyBusy={customSlotPriceBusy}
        />
      ) : null}

      {!editingSession ? (
        <View style={styles.sessionFooterActions}>
          <PrimaryButton
            label={t("sessionDetail.editSession")}
            onPress={() => {
              setNoteComposerOpen(false);
              setNoteDraft("");
              setEditingNoteId(null);
              setNoteEditDraft("");
              setUndoStack([]);
              setEditBaseline(
                JSON.stringify({
                  date,
                  time,
                  coachId,
                  coachLabel,
                  maxP,
                  durationMin,
                  open,
                  hidden,
                  isKickbox,
                  customSlotPriceDraft,
                })
              );
              setEditingSession(true);
            }}
            variant="ghost"
            style={styles.sessionFooterGhostBtn}
          />
          <PrimaryButton
            label={t("sessionDetail.duplicateSession")}
            onPress={openDuplicateModal}
            variant="ghost"
            style={styles.sessionFooterGhostBtn}
          />
          <PrimaryButton
            label={t("sessionDetail.deleteSession")}
            onPress={requestDeleteSession}
            disabled={deleteSessionBusy}
            variant="danger"
            style={styles.sessionFooterDangerBtn}
          />
        </View>
      ) : null}

      <AddParticipantToSessionModal
        sessionId={id}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          void load();
          setParticipantsRev((n) => n + 1);
        }}
      />
      <MoveParticipantSheet
        visible={moveOpen}
        onClose={() => {
          setMoveOpen(false);
          setMoveTarget(null);
        }}
        fromSessionId={String(id ?? "")}
        fromSessionDate={date}
        fromMaxParticipants={maxCap}
        fromParticipantCount={participantCount}
        participant={moveTarget}
        isManager
        onMoved={() => {
          setParticipantsRev((n) => n + 1);
          afterParticipantsChange();
        }}
      />
    </ScrollView>
        {!editingSession ? <SessionAdjacentNav variant="manager" sessionId={String(id ?? "")} /> : null}
      </View>
      <SessionSeriesScopeSheet
        visible={seriesScopeOpen}
        mode={seriesScopeMode}
        onClose={() => setSeriesScopeOpen(false)}
        onChoose={onSeriesScopeChosen}
      />
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  loading: { padding: theme.spacing.lg, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  /** Session hero: tonal surface + border (DESIGN § cards). */
  summaryCard: {
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  summaryKickboxBadge: { marginBottom: theme.spacing.xs },
  /** Uniform vertical rhythm between Edit / Duplicate / Delete (`PrimaryButton` defaults to marginTop: 8 — zero it here and use gap only). */
  sessionFooterActions: { marginTop: theme.spacing.md, gap: theme.spacing.sm },
  sessionFooterGhostBtn: { marginTop: 0 },
  summaryTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: theme.spacing.xs,
  },
  summaryTitleRowRtl: { flexDirection: "row-reverse" },
  summaryTitle: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 22,
    color: theme.colors.text,
  },
  seriesBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  seriesBadgeTxt: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.cta,
    letterSpacing: 0.2,
  },
  summaryLine: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.15,
    color: theme.colors.text,
    lineHeight: 23,
  },
  summaryCoachLine: {
    marginTop: theme.spacing.xs,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.15,
    color: theme.colors.textMuted,
    lineHeight: 22,
  },
  trainingSummaryBox: {
    marginTop: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  trainingSummaryTitle: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  summaryEmptyNote: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 20,
  },
  summaryTilesRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "stretch",
  },
  summaryTilesRowRtl: { flexDirection: "row-reverse" },
  summaryTile: {
    flex: 1,
    minWidth: 0,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  summaryTileRtl: { alignItems: "flex-end" },
  summaryTileLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: theme.colors.textSoft,
    marginBottom: 6,
  },
  summaryTileHero: {
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 0.2,
    color: theme.colors.text,
    marginBottom: 4,
  },
  summaryTileHint: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  summaryFootnote: {
    marginTop: theme.spacing.sm,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 17,
  },
  summaryFeesBox: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cancelChargeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  cancelChargeRowRtl: { flexDirection: "row-reverse" },
  cancelChargeBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
  },
  cancelChargeBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  cancelChargeBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  cancelChargeBtnTxtOn: { color: theme.colors.ctaText },
  cancelPenaltyRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  cancelPenaltyRowRtl: { flexDirection: "row-reverse" },
  penaltyMarkBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  penaltyMarkBtnTxt: { fontSize: 11, fontWeight: "800", color: theme.colors.cta },
  summaryEndedRow: {
    marginTop: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.successBg,
  },
  summaryEndedText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.15,
    color: theme.colors.success,
    lineHeight: 18,
  },
  summaryMeta: {
    marginTop: theme.spacing.sm,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    lineHeight: 16,
    color: theme.colors.textMuted,
  },
  sessionFooterDangerBtn: { marginTop: theme.spacing.sm },
  editBlock: {},
  optionsPanel: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  editSpacer: { height: theme.spacing.sm },
  h: {
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 22,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
  },
  hMuted: {
    color: theme.colors.textMuted,
    fontWeight: "700",
    fontSize: 17,
    letterSpacing: 0.15,
  },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  muted: { color: theme.colors.textSoft },
  waitCard: {
    marginTop: 6,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  waitCardRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  waitCardRowRtl: { flexDirection: "row-reverse" },
  waitCardMain: { flex: 1, minWidth: 0 },
  waitQuickBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
  },
  waitQuickBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  waitName: { color: theme.colors.text, fontWeight: "900", fontSize: 15 },
  waitMeta: { marginTop: 4, color: theme.colors.textMuted, fontWeight: "700" },
  notesCard: {
    marginTop: 4,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  noteCollapsedTrigger: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surfaceElevated,
  },
  noteCollapsedTriggerText: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.textMuted,
  },
  noteComposerActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  noteComposerActionsRtl: { flexDirection: "row-reverse" },
  noteCancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  noteCancelBtnTxt: { fontSize: 14, fontWeight: "800", color: theme.colors.textMuted },
  noteBtnInline: { marginTop: 0, flexShrink: 0, paddingHorizontal: 20 },
  noteListHint: { marginTop: theme.spacing.sm },
  noteInput: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    padding: 12,
    minHeight: 84,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  noteInputRtl: { textAlign: "right", writingDirection: "rtl" },
  noteBtn: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.cta,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  noteBtnTxt: { color: theme.colors.ctaText, fontWeight: "900" },
  noteList: { marginTop: theme.spacing.md, gap: 10 },
  noteRow: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
  noteMeta: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700" },
  noteBody: { marginTop: 6, color: theme.colors.text, fontWeight: "700", lineHeight: 18 },
  noteDelete: { marginTop: 0, alignSelf: "flex-start" },
  noteDeleteWeb: { cursor: "pointer" } as const,
  noteDeleteTxt: { color: theme.colors.error, fontWeight: "900" },
  noteEditInput: { marginTop: 6 },
  noteEditActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  noteEditActionsRtl: { flexDirection: "row-reverse" },
  noteRowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginTop: 10,
    alignSelf: "flex-start",
  },
  noteRowActionsRtl: { flexDirection: "row-reverse" },
  noteEditBtn: { alignSelf: "flex-start" },
  noteEditBtnTxt: { color: theme.colors.cta, fontWeight: "900" },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
    marginTop: 6,
    marginBottom: 8,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: theme.colors.white,
    justifyContent: "center",
    marginTop: 6,
    marginBottom: 8,
  },
  pickerText: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, fontWeight: "600", color: theme.colors.placeholderOnLight },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  modalBackdropTouch: { ...StyleSheet.absoluteFillObject },
  modalBox: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: theme.spacing.lg,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  modalTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  modalClose: { fontSize: 16, fontWeight: "900", color: theme.colors.cta },
  modalLoader: { paddingVertical: theme.spacing.xl },
  pickerItem: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md },
  pickerItemTextCol: { gap: 2 },
  pickerItemName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  pickerItemRole: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  pickerEmpty: { padding: theme.spacing.lg, textAlign: "center", color: theme.colors.textMuted },
  toggle: { padding: 12, backgroundColor: theme.colors.white, borderRadius: theme.radius.sm, marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  toggleText: { color: theme.colors.textOnLight, fontSize: 16 },
  toggleRtl: { alignItems: "flex-end" },
  toggleTextRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch", width: "100%" },
  undoBtn: {
    marginTop: 4,
    marginBottom: theme.spacing.sm,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  undoBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  cancelEdit: { marginTop: theme.spacing.sm, paddingVertical: 12, alignItems: "center" },
  cancelEditTxt: { color: theme.colors.textSoft, fontWeight: "700", fontSize: 15 },
  dupBackdrop: { flex: 1, justifyContent: "center", padding: theme.spacing.lg, backgroundColor: "rgba(0,0,0,0.55)" },
  dupBackdropTouch: { ...StyleSheet.absoluteFillObject },
  dupCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  dupTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.text, marginBottom: 6 },
  dupHint: { fontSize: 12, color: theme.colors.textSoft, lineHeight: 17, marginBottom: 10 },
  dupSectionLabel: {
    marginTop: 4,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.2,
  },
  dupChoiceRow: { flexDirection: "row", gap: 10 },
  dupChoiceRowRtl: { flexDirection: "row-reverse" },
  dupChoice: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  dupChoiceOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surface },
  dupChoiceTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted, textAlign: "center" },
  dupChoiceTxtOn: { color: theme.colors.cta, fontWeight: "900" },
  dupCancel: { marginTop: 10, paddingVertical: 10, alignItems: "center" },
  dupCancelTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  cancelCard: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cancelName: { color: theme.colors.text, fontWeight: "800" },
  cancelMeta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
  cancelReason: { marginTop: 6, color: theme.colors.text, lineHeight: 18 },
  chargeWarn: { marginTop: 8, color: theme.colors.error, fontWeight: "800" },
  chargeInfo: { marginTop: 8, color: theme.colors.textMuted, fontWeight: "700" },
});
