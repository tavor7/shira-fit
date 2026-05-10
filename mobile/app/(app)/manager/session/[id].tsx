import { useNavigation } from "@react-navigation/native";
import { router, useLocalSearchParams, useFocusEffect, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  Modal,
  FlatList,
  ActivityIndicator,
  useWindowDimensions,
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
import { DatePickerField } from "../../../../src/components/DatePickerField";
import { TimePickerField } from "../../../../src/components/TimePickerField";
import { isMissingColumnError } from "../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../src/lib/isoDate";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay, formatISODateFullWithWeekdayAfter } from "../../../../src/lib/dateFormat";
import { formatSessionStartTime, hasSessionNotEnded, isCancellationWithinHoursBeforeSession } from "../../../../src/lib/sessionTime";
import { useAuth } from "../../../../src/context/AuthContext";
import { sessionFormIsCompact, sessionFormStyles as sf } from "../../../../src/components/sessionFormStyles";
import { useToast } from "../../../../src/context/ToastContext";
import { copySessionParticipantsToNewSession } from "../../../../src/lib/copySessionParticipants";
import { useDiscardChangesPrompt } from "../../../../src/hooks/useDiscardChangesPrompt";
import { useAppAlert } from "../../../../src/context/AppAlertContext";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";
import { usePersistedState } from "../../../../src/hooks/usePersistedState";
import { uiDraftStorageKey } from "../../../../src/lib/uiDraftStorage";

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
  undoStack: EditSnapshot[];
  dupOpen: boolean;
  dupDate: string;
  dupTime: string;
  dupIncludeParticipants: boolean;
  noteDraft: string;
  noteComposerOpen: boolean;
  editingNoteId: string | null;
  noteEditDraft: string;
  showCoachPicker: boolean;
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
  undoStack: [],
  dupOpen: false,
  dupDate: "",
  dupTime: "",
  dupIncludeParticipants: false,
  noteDraft: "",
  noteComposerOpen: false,
  editingNoteId: null,
  noteEditDraft: "",
  showCoachPicker: false,
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
  const { user, profile } = useAuth();
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
  const { width } = useWindowDimensions();
  const compact = sessionFormIsCompact(width);
  const [participantsRev, setParticipantsRev] = useState(0);
  const [participantCount, setParticipantCount] = useState(0);
  const [attendanceStats, setAttendanceStats] = useState<SessionAttendanceStats>({
    registered: 0,
    arrived: 0,
    absent: 0,
    unset: 0,
    withPaymentMethod: 0,
    totalPaidIls: 0,
    noShowChargedCount: 0,
    noShowCollectedIls: 0,
  });
  const [sessionSlotPriceIls, setSessionSlotPriceIls] = useState<number | null>(null);
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
  const [coachOptions, setCoachOptions] = useState<CoachOption[]>([]);
  const [coachOptionsLoading, setCoachOptionsLoading] = useState(false);
  const [showCoachPicker, setShowCoachPicker] = useState(false);
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([]);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupDate, setDupDate] = useState("");
  const [dupTime, setDupTime] = useState("");
  const [dupBusy, setDupBusy] = useState(false);
  const [dupIncludeParticipants, setDupIncludeParticipants] = useState(false);
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

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
      }),
    [date, time, coachId, coachLabel, maxP, durationMin, open, hidden]
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
    setShowCoachPicker(d.showCoachPicker);
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
    setMaxP(d.maxP);
    setDurationMin(d.durationMin);
    setOpen(d.open);
    setHidden(d.hidden);
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
      undoStack,
      dupOpen,
      dupDate,
      dupTime,
      dupIncludeParticipants,
      noteDraft,
      noteComposerOpen,
      editingNoteId,
      noteEditDraft,
      showCoachPicker,
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
    undoStack,
    dupOpen,
    dupDate,
    dupTime,
    dupIncludeParticipants,
    noteDraft,
    noteComposerOpen,
    editingNoteId,
    noteEditDraft,
    showCoachPicker,
    pushDiag,
  ]);

  useEffect(() => {
    if (!editingSession) allowLeaveEditRef.current = false;
  }, [editingSession]);

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
      const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: sid, p_user_id: userId });
      if (error) {
        showToast({ message: t("common.error"), detail: error.message, variant: "error" });
        return;
      }
      if (data?.ok) {
        showToast({
          message: language === "he" ? "נוסף לאימון" : "Added to session",
          variant: "success",
        });
        await afterOk();
        return;
      }
      const code = String(data?.error ?? "");
      if (code === "full") {
        const title = language === "he" ? "האימון מלא" : "Session full";
        const msg =
          language === "he"
            ? "להגדיל את המקסימום ב-1 ולהוסיף את המתאמן?"
            : "Increase max participants by 1 and add this athlete?";
        const cancelLbl = language === "he" ? "ביטול" : "Cancel";
        const okLbl = language === "he" ? "המשך" : "Continue";

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
            const r2 = await supabase.rpc("coach_add_athlete", { p_session_id: sid, p_user_id: userId });
            if (r2.error) {
              showToast({ message: t("common.error"), detail: r2.error.message, variant: "error" });
              return;
            }
            if (r2.data?.ok) {
              showToast({
                message: language === "he" ? "נוסף לאימון" : "Added to session",
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
      showOk(t("common.failed"), String(data?.error ?? ""));
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
      setMaxP(String(s.max_participants));
      setDurationMin(String(s.duration_minutes ?? 60));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
      const { data: priceRow } = await supabase
        .from("session_capacity_pricing")
        .select("price_ils")
        .eq("max_participants", s.max_participants)
        .maybeSingle();
      const p = priceRow?.price_ils;
      setSessionSlotPriceIls(p != null && Number.isFinite(Number(p)) ? Number(p) : null);
    } else {
      setSessionSlotPriceIls(null);
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
    const msg =
      language === "he" ? "למחוק את ההערה?" : "Delete this note?";
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
      showToast({ message: language === "he" ? "הערה נמחקה" : "Note removed", variant: "success" });
    };
    showConfirm({
      title: language === "he" ? "מחיקת הערה" : "Delete note",
      message: msg,
      cancelLabel: language === "he" ? "ביטול" : "Cancel",
      confirmLabel: language === "he" ? "מחיקה" : "Delete",
      confirmVariant: "danger",
      onConfirm: () => void run(),
    });
  }

  const loadCoaches = useCallback(async () => {
    setCoachOptionsLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, username")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setCoachOptions((data as CoachOption[]) ?? []);
    setCoachOptionsLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!editingSession) return;
      loadCoaches();
    }, [editingSession, loadCoaches])
  );

  function selectCoach(opt: CoachOption) {
    pushUndo();
    setCoachId(opt.user_id);
    setCoachLabel(`${opt.full_name} — ${opt.role}`);
    setShowCoachPicker(false);
  }

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    (async () => {
      if (!coachId) return;
      // If we already have a label for this id, keep it.
      if (coachLabel && coachOptions.some((c) => c.user_id === coachId)) return;
      const fromList = coachOptions.find((c) => c.user_id === coachId);
      if (fromList) {
        setCoachLabel(`${fromList.full_name} — ${fromList.role}`);
        return;
      }
      const { data } = await supabase.from("profiles").select("user_id, full_name, role, username").eq("user_id", coachId).single();
      if (data) {
        const d = data as CoachOption;
        setCoachLabel(`${d.full_name} — ${d.role}`);
      }
    })();
  }, [coachId, coachLabel, coachOptions]);

  function pushUndo() {
    setUndoStack((prev) => {
      const snap: EditSnapshot = { date, time, coachId, coachLabel, maxP, durationMin, open, hidden };
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
        head.hidden === snap.hidden
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
      return prev.slice(0, -1);
    });
  }

  async function saveSession() {
    if (!isValidISODateString(date.trim())) {
      showOk(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    if (!coachId) {
      showOk(
        language === "he" ? "חסר מאמן" : "Missing trainer",
        language === "he" ? "בחרו מאמן/ת." : "Please choose a trainer."
      );
      return;
    }
    const payload = {
      session_date: date.trim(),
      start_time: time,
      coach_id: coachId,
      max_participants: parseInt(maxP, 10) || 1,
      duration_minutes: Math.min(24 * 60, Math.max(1, parseInt(durationMin, 10) || 60)),
      is_open_for_registration: open,
      is_hidden: hidden,
    };
    let { error } = await supabase.from("training_sessions").update(payload).eq("id", id);
    let savedWithoutHidden = false;
    if (error && isMissingColumnError(error.message, "is_hidden")) {
      const { is_hidden: _h, ...rest } = payload;
      const retry = await supabase.from("training_sessions").update(rest).eq("id", id);
      error = retry.error;
      if (!error) savedWithoutHidden = true;
    }
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    await load();
    setEditingSession(false);
    setEditBaseline(null);
    pushDiag("clearPersisted: saveSession success");
    void persistDraft.clearPersisted();
    if (savedWithoutHidden) {
      showOk(
        language === "he" ? "הערה" : "Note",
        language === "he"
          ? "העמודה לאימון מוסתר עדיין לא קיימת במסד הנתונים; שאר השדות נשמרו."
          : "Hidden-session column is not on the database yet; other fields were saved."
      );
    }
  }

  async function duplicateSession() {
    const d = dupDate.trim();
    if (!isValidISODateString(d)) {
      showOk(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    if (!coachId) {
      showOk(
        language === "he" ? "חסר מאמן" : "Missing trainer",
        language === "he" ? "בחרו מאמן/ת." : "Please choose a trainer."
      );
      return;
    }
    setDupBusy(true);
    const payload = {
      session_date: d,
      start_time: dupTime || time,
      coach_id: coachId,
      max_participants: parseInt(maxP, 10) || 1,
      duration_minutes: Math.min(24 * 60, Math.max(1, parseInt(durationMin, 10) || 60)),
      is_open_for_registration: false,
      is_hidden: hidden,
    };
    let res = await supabase.from("training_sessions").insert(payload).select("id").maybeSingle();
    let error = res.error;
    if (error && isMissingColumnError(error.message, "is_hidden")) {
      const { is_hidden: _h, ...rest } = payload as any;
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
          message: language === "he" ? "האימון שוכפל — חלק מהמשתתפים לא הועתקו" : "Session copied — some participants were not copied",
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
    setDupOpen(true);
  }

  async function runDeleteSession() {
    const sid = String(id ?? "").trim();
    if (!sid) return;
    setDeleteSessionBusy(true);
    const { error } = await supabase.from("training_sessions").delete().eq("id", sid);
    setDeleteSessionBusy(false);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    pushDiag("clearPersisted: runDeleteSession success");
    void persistDraft.clearPersisted();
    router.replace("/(app)/manager/sessions");
  }

  function requestDeleteSession() {
    const msg =
      language === "he"
        ? "למחוק את האימון? גם ההרשמות אליו יימחקו."
        : "Delete this session? Registrations for it will be removed too.";
    showConfirm({
      title: language === "he" ? "מחיקת אימון?" : "Delete session?",
      message: msg,
      cancelLabel: language === "he" ? "ביטול" : "Cancel",
      confirmLabel: language === "he" ? "מחק" : "Delete",
      confirmVariant: "danger",
      onConfirm: () => void runDeleteSession(),
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
    setAttendanceStats(s);
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

  const extraFeeSummary = useMemo(() => {
    if (!session) {
      return {
        lateExpected: null as number | null,
        lateCollected: 0,
        lateChargedCount: 0,
        nsExpected: null as number | null,
        nsCollected: 0,
        nsCount: 0,
        hasAny: false,
      };
    }
    const slot = sessionSlotPriceIls;
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
    const lateExpected = slot != null && lateCharged.length > 0 ? lateCharged.length * slot : null;
    const nsCount = attendanceStats.noShowChargedCount;
    const nsExpected = slot != null && nsCount > 0 ? nsCount * slot : null;
    const nsCollected = attendanceStats.noShowCollectedIls;
    const hasAny = lateCharged.length > 0 || nsCount > 0;
    return {
      lateExpected,
      lateCollected,
      lateChargedCount: lateCharged.length,
      nsExpected,
      nsCollected,
      nsCount,
      hasAny,
    };
  }, [
    session,
    sessionSlotPriceIls,
    cancellations,
    attendanceStats.noShowChargedCount,
    attendanceStats.noShowCollectedIls,
  ]);

  const draftDiagPanelEl = (() => {
    if (!MANAGER_SESSION_DRAFT_DIAGNOSTICS) return null;
    let lsPresent = false;
    let lsRaw: string | null = null;
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      try {
        lsRaw = localStorage.getItem(draftStorageKey);
        lsPresent = lsRaw != null && lsRaw !== "";
      } catch {
        lsRaw = "(localStorage read error)";
      }
    }
    const lsHasTest = (lsRaw ?? "").includes("TEST123");
    const rawTrunc =
      lsRaw == null
        ? Platform.OS === "web"
          ? "(null)"
          : "(N/A: not web)"
        : lsRaw.length > 320
          ? `${lsRaw.slice(0, 320)}…`
          : lsRaw;
    const uiNoteSnippet = JSON.stringify(String(uiDraft.noteDraft ?? "").slice(0, 64));
    const inputNoteSnippet = JSON.stringify(String(noteDraft ?? "").slice(0, 64));
    const logText = diagLogRef.current.join("\n");

    return (
      <View style={styles.draftDiag}>
        <Text style={styles.draftDiagTitle}>Draft diagnostics (manager session — temporary)</Text>
        <Text style={styles.draftDiagLine} selectable>
          1) draftStorageKey: {draftStorageKey}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          2) localStorage has key: {Platform.OS === "web" ? String(lsPresent) : "N/A (native)"} · raw includes TEST123: {String(lsHasTest)}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          3) raw localStorage (trunc): {rawTrunc}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          4) uiDraft (hook state) noteDraft {uiNoteSnippet} · noteComposerOpen={String(uiDraft.noteComposerOpen)} · hydrated=
          {String(persistDraft.hydrated)}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          5) Input state noteDraft {inputNoteSnippet} · noteComposerOpen={String(noteComposerOpen)} · match uiDraft.note?{" "}
          {String(uiDraft.noteDraft === noteDraft)}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          6) server: serverFormReady={String(serverFormReady)} · load#={loadCountRef.current} · lastLoadAt=
          {loadFinishedAtRef.current ?? "—"} · draftMergedRef={String(draftMergedIntoLocalRef.current)}
        </Text>
        <Text style={styles.draftDiagLine} selectable>
          7) Event log (newest first):{"\n"}
          {logText || "—"}
        </Text>
      </View>
    );
  })();

  if (!session)
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.backgroundAlt }}>
        <Stack.Screen options={{ title: t("screen.managerSession") }} />
        <Text style={[styles.loading, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
        {draftDiagPanelEl}
      </View>
    );

  const durationMinutesForEnded = Math.max(1, parseInt(durationMin, 10) || 60);
  const sessionHasEnded = !hasSessionNotEnded(date, time, durationMinutesForEnded);
  const maxCap = Math.max(1, parseInt(maxP, 10) || session.max_participants || 1);
  const coachNameOnly = coachDisplayNameFromLabel(coachLabel);
  const arrivalRatePct =
    attendanceStats.registered > 0
      ? Math.round((attendanceStats.arrived / attendanceStats.registered) * 100)
      : 0;

  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerSession") }} />
      <View style={styles.root}>
        <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}>
      {!editingSession ? (
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryTitle, isRTL && styles.rtlText]}>{language === "he" ? "אימון" : "Session"}</Text>
          <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>
            {formatISODateFullWithWeekdayAfter(date, language)} · {formatSessionStartTime(time)} · {durationMin}{" "}
            {language === "he" ? "דק׳" : "min"}
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
            {language === "he" ? "פתוח להרשמה: " : "Open: "}
            {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
            {" · "}
            {language === "he" ? "מוסתר: " : "Hidden: "}
            {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
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
                        .replace("{arrived}", String(attendanceStats.arrived))
                        .replace("{registered}", String(attendanceStats.registered))}
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
                      {formatIls(attendanceStats.totalPaidIls, language)}
                    </Text>
                    <Text style={[styles.summaryTileHint, isRTL && styles.rtlText]}>
                      {attendanceStats.totalPaidIls > 0
                        ? t("managerSession.summaryPaymentsSubRecorded")
                            .replace("{n}", String(attendanceStats.withPaymentMethod))
                            .replace("{total}", String(attendanceStats.registered))
                        : attendanceStats.withPaymentMethod > 0
                          ? t("managerSession.summaryPaymentsSubMethodsOnly").replace(
                              "{n}",
                              String(attendanceStats.withPaymentMethod)
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
      ) : (
        <View style={styles.editBlock}>
          <View style={sf.card}>
            <Text style={sf.cardTitle}>{language === "he" ? "מתי" : "When"}</Text>
            <View style={[sf.row, compact && sf.rowStack]}>
              <View style={sf.col}>
                <DatePickerField
                  label={language === "he" ? "תאריך אימון" : "Session date"}
                  value={date}
                  onChange={(v) => {
                    pushUndo();
                    setDate(v);
                  }}
                />
              </View>
              <View style={sf.col}>
                <TimePickerField
                  label={language === "he" ? "שעת התחלה" : "Start time"}
                  value={time}
                  onChange={(v) => {
                    pushUndo();
                    setTime(v);
                  }}
                />
              </View>
            </View>
          </View>

          <View style={sf.card}>
            <Text style={sf.cardTitle}>{language === "he" ? "מאמן" : "Trainer"}</Text>
            <Pressable
              style={({ pressed }) => [sf.control, pressed && { opacity: 0.9 }, { justifyContent: "center" }]}
              onPress={() => setShowCoachPicker(true)}
            >
              <Text style={coachLabel ? sf.controlText : sf.controlPlaceholder} numberOfLines={1} ellipsizeMode="tail">
                {coachLabel || (language === "he" ? "בחירת מאמן לפי שם…" : "Choose trainer by name…")}
              </Text>
            </Pressable>
          <Modal visible={showCoachPicker} transparent animationType="slide" onRequestClose={() => setShowCoachPicker(false)}>
            <View style={styles.modalBackdrop}>
              <Pressable style={styles.modalBackdropTouch} onPress={() => setShowCoachPicker(false)} accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"} />
              <View style={styles.modalBox}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{language === "he" ? "כל המאמנים" : "All trainers"}</Text>
                  <Pressable onPress={() => setShowCoachPicker(false)} hitSlop={12}>
                    <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
                  </Pressable>
                </View>
                {coachOptionsLoading ? (
                  <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
                ) : (
                  <FlatList
                    data={coachOptions}
                    keyExtractor={(item) => item.user_id}
                    renderItem={({ item }) => (
                      <Pressable style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]} onPress={() => selectCoach(item)}>
                        <View style={styles.pickerItemTextCol}>
                          <Text style={styles.pickerItemName} numberOfLines={1} ellipsizeMode="tail">
                            {item.full_name}
                          </Text>
                          <Text style={styles.pickerItemRole} numberOfLines={1} ellipsizeMode="tail">
                            @{item.username} · {item.role}
                          </Text>
                        </View>
                      </Pressable>
                    )}
                    ListEmptyComponent={
                      <Text style={styles.pickerEmpty}>{language === "he" ? "עדיין אין מאמנים" : "No trainers yet"}</Text>
                    }
                  />
                )}
              </View>
            </View>
          </Modal>
          </View>

          <View style={sf.card}>
            <Text style={sf.cardTitle}>{language === "he" ? "קיבולת" : "Capacity"}</Text>
            <View style={[sf.row, compact && sf.rowStack]}>
              <View style={sf.col}>
                <Text style={[sf.label, isRTL && sf.labelRtl]}>{language === "he" ? "משך (דקות)" : "Length (min)"}</Text>
                <TextInput
                  style={[sf.control, sf.controlInput]}
                  value={durationMin}
                  onChangeText={(v) => {
                    pushUndo();
                    setDurationMin(v);
                  }}
                  keyboardType="number-pad"
                  placeholderTextColor={theme.colors.textSoft}
                />
              </View>
              <View style={sf.col}>
                <Text style={[sf.label, isRTL && sf.labelRtl]}>{language === "he" ? "מקסימום משתתפים" : "Max participants"}</Text>
                <TextInput
                  style={[sf.control, sf.controlInput]}
                  value={maxP}
                  onChangeText={(v) => {
                    pushUndo();
                    setMaxP(v);
                  }}
                  keyboardType="number-pad"
                  placeholderTextColor={theme.colors.textSoft}
                />
              </View>
            </View>
          </View>

          <View style={sf.card}>
            <Text style={sf.cardTitle}>{language === "he" ? "אפשרויות" : "Options"}</Text>
            <Pressable
              style={({ pressed }) => [sf.toggle, pressed && { opacity: 0.9 }, isRTL && styles.toggleRtl]}
              onPress={() => {
                pushUndo();
                setOpen(!open);
              }}
            >
              <Text style={[sf.toggleText, isRTL && styles.toggleTextRtl]}>
                {language === "he" ? "פתוח להרשמה: " : "Open for registration: "}
                {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
              </Text>
            </Pressable>
            <View style={styles.editSpacer} />
            <Pressable
              style={({ pressed }) => [sf.toggle, pressed && { opacity: 0.9 }, isRTL && styles.toggleRtl]}
              onPress={() => {
                pushUndo();
                setHidden(!hidden);
              }}
            >
              <Text style={[sf.toggleText, isRTL && styles.toggleTextRtl]}>
                {language === "he" ? "מוסתר (צוות בלבד): " : "Hidden (staff-only): "}
                {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
              </Text>
            </Pressable>
          </View>

          <View style={[sf.card, { marginBottom: 0 }]}>
            <Pressable
              onPress={undoLast}
              disabled={undoStack.length === 0}
              style={({ pressed }) => [
                styles.undoBtn,
                pressed && undoStack.length > 0 && { opacity: 0.85 },
                undoStack.length === 0 && { opacity: 0.45 },
              ]}
            >
              <Text style={styles.undoBtnTxt}>{language === "he" ? "ביטול שינוי אחרון" : "Undo last change"}</Text>
            </Pressable>
            <PrimaryButton label={t("common.save")} onPress={saveSession} />
            <View style={styles.editSpacer} />
            <Pressable onPress={requestCancelEdit} style={({ pressed }) => [styles.cancelEdit, pressed && { opacity: 0.85 }]}>
              <Text style={styles.cancelEditTxt}>{language === "he" ? "ביטול" : "Cancel"}</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Modal visible={dupOpen} transparent animationType="fade" onRequestClose={() => (dupBusy ? null : setDupOpen(false))}>
        <View style={styles.dupBackdrop}>
          <Pressable style={styles.dupBackdropTouch} onPress={() => (dupBusy ? null : setDupOpen(false))} />
          <View style={styles.dupCard}>
            <Text style={[styles.dupTitle, isRTL && styles.rtlText]}>{language === "he" ? "שכפול אימון" : "Duplicate session"}</Text>
            <View style={[sf.row, compact && sf.rowStack]}>
              <View style={sf.col}>
                <DatePickerField label={language === "he" ? "תאריך חדש" : "New date"} value={dupDate} onChange={setDupDate} />
              </View>
              <View style={sf.col}>
                <TimePickerField label={language === "he" ? "שעה חדשה" : "New time"} value={dupTime} onChange={setDupTime} />
              </View>
            </View>
            <Text style={[styles.dupSectionLabel, isRTL && styles.rtlText]}>
              {language === "he" ? "משתתפים" : "Participants"}
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
                  {language === "he" ? "בלי משתתפים" : "Without participants"}
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
                  {language === "he" ? "עם אותם נרשמים" : "With same roster"}
                </Text>
              </Pressable>
            </View>
            <View style={styles.editSpacer} />
            <PrimaryButton
              label={language === "he" ? "צור עותק" : "Create copy"}
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
        {language === "he" ? "משתתפים ונוכחות" : "Participants & attendance"}
        <Text style={styles.hMuted}>
          {" "}
          ({participantCount}/{maxCap})
        </Text>
      </Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={load}
        onParticipantCountChange={handleParticipantCountChange}
        onAttendanceStatsChange={handleAttendanceStatsChange}
        onRemoveAthlete={removeAthlete}
        onRemoveManualParticipant={removeManual}
      />

      <PrimaryButton
        label={language === "he" ? "הוספת משתתף" : "Add participant"}
        onPress={() => setAddOpen(true)}
        variant="ghost"
      />

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "רשימת המתנה" : "Waitlist"}</Text>
      {waitlist.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        waitlist.map((item) => {
          const p = item.profiles ? (Array.isArray(item.profiles) ? item.profiles[0] : item.profiles) : null;
          const name = String(p?.full_name ?? item.user_id);
          const phone = String(p?.phone ?? "").trim();
          const busy = waitlistQuickUserId === item.user_id;
          return (
            <View key={item.user_id} style={styles.waitCard}>
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
                  accessibilityLabel={language === "he" ? "הוספה מהירה לאימון" : "Quick add to session"}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.colors.ctaText} />
                  ) : (
                    <Text style={styles.waitQuickBtnTxt}>{language === "he" ? "הוסף" : "Add"}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          );
        })
      )}

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          const sched = session
            ? isCancellationWithinHoursBeforeSession(session.session_date, session.start_time, c.cancelled_at, 12)
            : false;
          const feeCharged = c.charged_full_price === true;
          const penaltyNum = Number(c.penalty_collected_ils ?? 0);
          const collected = Number.isFinite(penaltyNum) ? penaltyNum : 0;
          return (
            <View key={c.id} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>{language === "he" ? "סיבה: " : "Reason: "}{c.reason}</Text>
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
                      {sessionSlotPriceIls != null && sessionSlotPriceIls > 0 ? (
                        <Pressable
                          onPress={() =>
                            void setCancellationPenaltyCollected(c.id, sessionSlotPriceIls as number)
                          }
                          style={({ pressed }) => [styles.penaltyMarkBtn, pressed && { opacity: 0.88 }]}
                        >
                          <Text style={styles.penaltyMarkBtnTxt}>{t("managerSession.penaltyMarkFull")}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>
          );
        })
      )}


      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "הערות" : "Notes"}</Text>
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
              {language === "he" ? "הקשו להוספת הערה לצוות…" : "Tap to add a staff-only note…"}
            </Text>
          </Pressable>
        ) : (
          <View>
            <TextInput
              style={[styles.noteInput, isRTL && styles.noteInputRtl]}
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder={language === "he" ? "הוספת הערה לצוות…" : "Add a staff-only note…"}
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
                <Text style={styles.noteCancelBtnTxt}>{language === "he" ? "סגירה" : "Close"}</Text>
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
                  <Text style={styles.noteBtnTxt}>{language === "he" ? "שמירה" : "Save note"}</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}

        {notes.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtlText, styles.noteListHint]}>
            {language === "he" ? "אין הערות שמורות." : "No saved notes yet."}
          </Text>
        ) : (
          <View style={styles.noteList}>
            {notes.map((n) => {
              const p = n.profiles ? (Array.isArray(n.profiles) ? n.profiles[0] : n.profiles) : null;
              const name = p?.full_name ?? n.author_id;
              const canDelete = (profile?.role === "manager") || (!!user?.id && user.id === n.author_id);
              const isEditing = editingNoteId === n.id;
              return (
                <View key={n.id} style={styles.noteRow}>
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
                          <Text style={styles.noteCancelBtnTxt}>{language === "he" ? "ביטול" : "Cancel"}</Text>
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
                            <Text style={styles.noteBtnTxt}>{language === "he" ? "שמירה" : "Save"}</Text>
                          )}
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <Text style={[styles.noteBody, isRTL && styles.rtlText]}>{n.body}</Text>
                  )}
                  {!isEditing && canDelete ? (
                    <View style={[styles.noteRowActions, isRTL && styles.noteRowActionsRtl]}>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        delayPressIn={0}
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
                        <Text style={styles.noteEditBtnTxt}>{language === "he" ? "עריכה" : "Edit"}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        delayPressIn={0}
                        onPress={() => void deleteNote(n.id)}
                        {...(Platform.OS === "web" ? ({ onClick: () => void deleteNote(n.id) } as any) : null)}
                        style={[styles.noteDelete, Platform.OS === "web" && styles.noteDeleteWeb]}
                        accessibilityRole="button"
                      >
                        <Text style={styles.noteDeleteTxt}>{language === "he" ? "מחיקה" : "Delete"}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </View>

      {!editingSession ? (
        <View style={styles.sessionFooterActions}>
          <PrimaryButton
            label={language === "he" ? "עריכת אימון" : "Edit session"}
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
                })
              );
              setEditingSession(true);
            }}
            variant="ghost"
            style={styles.sessionFooterGhostBtn}
          />
          <>
            <PrimaryButton
              label={language === "he" ? "שכפול אימון" : "Duplicate session"}
              onPress={openDuplicateModal}
              variant="ghost"
              style={styles.sessionFooterGhostBtn}
            />
            <Pressable
              style={({ pressed }) => [styles.sessionDangerBtnGhost, pressed && styles.sessionDangerBtnPressed]}
              onPress={requestDeleteSession}
              disabled={deleteSessionBusy}
              accessibilityRole="button"
              accessibilityLabel={language === "he" ? "מחיקת אימון" : "Delete session"}
            >
              <Text style={[styles.sessionDangerBtnGhostTxt, isRTL && styles.rtlText]}>{language === "he" ? "מחיקת אימון" : "Delete session"}</Text>
            </Pressable>
          </>
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
      {draftDiagPanelEl}
    </ScrollView>
        {!editingSession ? <SessionAdjacentNav variant="manager" sessionId={String(id ?? "")} /> : null}
      </View>
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  loading: { padding: theme.spacing.lg, color: theme.colors.textMuted },
  draftDiag: {
    marginTop: theme.spacing.md,
    padding: 10,
    backgroundColor: "#121212",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: "#333",
  },
  draftDiagTitle: { color: "#ffcc00", fontWeight: "900", marginBottom: 8, fontSize: 12 },
  draftDiagLine: {
    color: "#e8e8e8",
    fontSize: 10,
    fontFamily: Platform.OS === "web" ? "monospace" : Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    marginBottom: 6,
    lineHeight: 14,
  },
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
  /** Uniform vertical rhythm between Edit / Duplicate / Delete (`PrimaryButton` defaults to marginTop: 8 — zero it here and use gap only). */
  sessionFooterActions: { marginTop: theme.spacing.md, gap: theme.spacing.sm },
  sessionFooterGhostBtn: { marginTop: 0 },
  summaryTitle: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 22,
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
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
  /** Same size/radius as ghost `PrimaryButton`; light red fill + border so it reads as destructive but matches pill layout. */
  sessionDangerBtnGhost: {
    marginTop: 0,
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: theme.radius.md,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239, 68, 68, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.42)",
  },
  sessionDangerBtnPressed: { opacity: 0.88 },
  sessionDangerBtnGhostTxt: {
    color: theme.colors.error,
    fontWeight: "600",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  editBlock: { marginBottom: theme.spacing.md },
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
