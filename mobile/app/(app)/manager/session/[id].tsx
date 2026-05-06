import { router, useLocalSearchParams, useFocusEffect, Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  Alert,
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
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { DatePickerField } from "../../../../src/components/DatePickerField";
import { TimePickerField } from "../../../../src/components/TimePickerField";
import { isMissingColumnError } from "../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../src/lib/isoDate";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay, formatISODateFullWithWeekdayAfter } from "../../../../src/lib/dateFormat";
import { isCancellationWithinHoursBeforeSession } from "../../../../src/lib/sessionTime";
import { useAuth } from "../../../../src/context/AuthContext";
import { sessionFormIsCompact, sessionFormStyles as sf } from "../../../../src/components/sessionFormStyles";
import { useToast } from "../../../../src/context/ToastContext";
import { copySessionParticipantsToNewSession } from "../../../../src/lib/copySessionParticipants";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";

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

type NoteRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: string;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

type CancellationRow = {
  user_id: string;
  cancelled_at: string;
  reason: string;
  charged_full_price: boolean;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

type WaitlistRow = {
  user_id: string;
  requested_at: string;
  profiles: { full_name: string; phone?: string | null } | { full_name: string; phone?: string | null }[] | null;
};

export default function ManagerSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { user, profile } = useAuth();
  const { showToast } = useToast();
  const { width } = useWindowDimensions();
  const compact = sessionFormIsCompact(width);
  const [participantsRev, setParticipantsRev] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [editingSession, setEditingSession] = useState(false);
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
  const [pendingDeleteSession, setPendingDeleteSession] = useState(false);
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
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const [waitlistQuickUserId, setWaitlistQuickUserId] = useState<string | null>(null);

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
              Alert.alert(t("common.failed"), String(r2.data?.error ?? ""));
            }
          } finally {
            setWaitlistQuickUserId(null);
          }
        };

        if (Platform.OS === "web" && typeof window !== "undefined") {
          try {
            // eslint-disable-next-line no-alert
            if (window.confirm(`${title}\n\n${msg}`)) void bumpAndRetry();
          } catch {
            Alert.alert(title, msg, [
              { text: cancelLbl, style: "cancel" },
              { text: okLbl, onPress: () => void bumpAndRetry() },
            ]);
          }
        } else {
          Alert.alert(title, msg, [
            { text: cancelLbl, style: "cancel" },
            { text: okLbl, onPress: () => void bumpAndRetry() },
          ]);
        }
        return;
      }
      Alert.alert(t("common.failed"), code || t("common.failed"));
    } finally {
      setWaitlistQuickUserId(null);
    }
  }

  async function loadCancellations() {
    const { data, error } = await supabase
      .from("cancellations")
      .select("user_id, cancelled_at, reason, charged_full_price, profiles(full_name)")
      .eq("session_id", id)
      .order("cancelled_at", { ascending: false });
    if (error) {
      setCancellations([]);
      return;
    }
    setCancellations((data as unknown as CancellationRow[]) ?? []);
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
    const { data: s } = await supabase.from("training_sessions").select("*").eq("id", id).single();
    setSession(s as TrainingSession);
    if (s) {
      setDate(s.session_date);
      setTime(s.start_time);
      setCoachId(s.coach_id);
      setMaxP(String(s.max_participants));
      setDurationMin(String(s.duration_minutes ?? 60));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
    }
    loadWaitlist();
    loadCancellations();
    loadNotes();
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
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(t("common.failed"), data?.error ?? "");
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
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(t("common.failed"), String(data?.error ?? ""));
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
        Alert.alert(t("common.error"), error.message);
        return;
      }
      if (!data?.ok) {
        Alert.alert(t("common.failed"), String(data?.error ?? ""));
        return;
      }
      await loadNotes();
      showToast({ message: language === "he" ? "הערה נמחקה" : "Note removed", variant: "success" });
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      // RN Web often doesn't surface Alert reliably. Use a native confirm dialog.
      try {
        const ok = typeof window.confirm === "function"
          ? window.confirm(`${language === "he" ? "מחיקת הערה" : "Delete note"}\n\n${msg}`)
          : true;
        if (!ok) return;
        await run();
      } catch {
        // Some embedded webviews block confirm dialogs. Fall back to running the delete.
        await run();
      }
      return;
    }
    Alert.alert(language === "he" ? "מחיקת הערה" : "Delete note", msg, [
      { text: language === "he" ? "ביטול" : "Cancel", style: "cancel" },
      { text: language === "he" ? "מחיקה" : "Delete", style: "destructive", onPress: () => void run() },
    ]);
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
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    if (!coachId) {
      Alert.alert(language === "he" ? "חסר מאמן" : "Missing trainer", language === "he" ? "בחרו מאמן/ת." : "Please choose a trainer.");
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
      Alert.alert(t("common.error"), error.message);
      return;
    }
    await load();
    setEditingSession(false);
    if (savedWithoutHidden) {
      Alert.alert(
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
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    if (!coachId) {
      Alert.alert(language === "he" ? "חסר מאמן" : "Missing trainer", language === "he" ? "בחרו מאמן/ת." : "Please choose a trainer.");
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
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
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
    setPendingDeleteSession(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    router.replace("/(app)/manager/sessions");
  }

  function requestDeleteSession() {
    const msg =
      language === "he"
        ? "למחוק את האימון? גם ההרשמות אליו יימחקו."
        : "Delete this session? Registrations for it will be removed too.";
    if (Platform.OS === "web") {
      setPendingDeleteSession(true);
      return;
    }
    Alert.alert(language === "he" ? "מחיקת אימון?" : "Delete session?", msg, [
      { text: language === "he" ? "ביטול" : "Cancel", style: "cancel" },
      {
        text: language === "he" ? "מחק" : "Delete",
        style: "destructive",
        onPress: () => void runDeleteSession(),
      },
    ]);
  }

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("manager_remove_athlete", {
      p_session_id: id,
      p_user_id: userId,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      load();
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  async function removeManual(manualId: string) {
    const { data, error } = await supabase.rpc("remove_manual_participant_from_session", {
      p_session_id: id,
      p_manual_participant_id: manualId,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      load();
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  if (!session)
    return (
      <View>
        <Stack.Screen options={{ title: t("screen.managerSession") }} />
        <Text style={[styles.loading, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
    );

  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerSession") }} />
      <View style={styles.root}>
        <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}>
      {!editingSession ? (
        <View style={styles.summaryBlock}>
          <Text style={[styles.summaryTitle, isRTL && styles.rtlText]}>{language === "he" ? "אימון" : "Session"}</Text>
          <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>
            {formatISODateFullWithWeekdayAfter(date, language)} · {time} · {durationMin} {language === "he" ? "דק׳" : "min"} ·{" "}
            {language === "he" ? "עד" : "max"} {maxP}
          </Text>
          <Text style={[styles.summaryMeta, isRTL && styles.rtlText]}>
            {language === "he" ? "פתוח להרשמה: " : "Open: "}
            {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
            {" · "}
            {language === "he" ? "מוסתר: " : "Hidden: "}
            {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
          </Text>
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
            <View style={{ height: 10 }} />
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
            <View style={{ height: 10 }} />
            <Pressable
              onPress={() => {
                void load();
                setEditingSession(false);
              }}
              style={({ pressed }) => [styles.cancelEdit, pressed && { opacity: 0.85 }]}
            >
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
            <View style={{ height: 12 }} />
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

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "משתתפים ונוכחות" : "Participants & attendance"}</Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={load}
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
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>{language === "he" ? "סיבה: " : "Reason: "}{c.reason}</Text>
              {sched ? (
                <Text style={styles.chargeWarn}>
                  {language === "he" ? "ביטול מאוחר (<12ש׳ לפני האימון)" : "Late cancellation (<12h before session)"}
                </Text>
              ) : c.charged_full_price ? (
                <Text style={styles.chargeInfo}>
                  {language === "he"
                    ? "ביטול בטווח חיוב (<24ש׳ לפני האימון) — ייתכן חיוב"
                    : "Within charge window (<24h before start) — may be charged"}
                </Text>
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
              setPendingDeleteSession(false);
              setEditingSession(true);
            }}
            variant="ghost"
            style={styles.sessionFooterGhostBtn}
          />
          {Platform.OS === "web" && pendingDeleteSession ? (
            <View style={styles.sessionDeleteConfirm}>
              <Text style={[styles.sessionDeleteConfirmTxt, isRTL && styles.rtlText]}>
                {language === "he"
                  ? "למחוק את האימון? ההרשמות יימחקו."
                  : "Delete this session? Registrations will be removed."}
              </Text>
              <View style={[styles.sessionDeleteConfirmRow, isRTL && styles.sessionDeleteConfirmRowRtl]}>
                <Pressable
                  style={({ pressed }) => [styles.sessionDeleteCancelBtn, pressed && { opacity: 0.88 }]}
                  onPress={() => !deleteSessionBusy && setPendingDeleteSession(false)}
                  disabled={deleteSessionBusy}
                >
                  <Text style={styles.sessionDeleteCancelTxt}>{language === "he" ? "ביטול" : "Cancel"}</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.sessionDeleteOkBtn, pressed && { opacity: 0.9 }]}
                  onPress={() => void runDeleteSession()}
                  disabled={deleteSessionBusy}
                >
                  {deleteSessionBusy ? (
                    <ActivityIndicator color={theme.colors.white} size="small" />
                  ) : (
                    <Text style={styles.sessionDeleteOkTxt}>{language === "he" ? "מחק" : "Delete"}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
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
          )}
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
    </ScrollView>
        {!editingSession ? <SessionAdjacentNav variant="manager" sessionId={String(id ?? "")} /> : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  loading: { padding: theme.spacing.lg, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  summaryBlock: { marginBottom: theme.spacing.sm },
  /** Uniform vertical rhythm between Edit / Duplicate / Delete (`PrimaryButton` defaults to marginTop: 8 — zero it here and use gap only). */
  sessionFooterActions: { marginTop: theme.spacing.md, gap: theme.spacing.sm },
  sessionFooterGhostBtn: { marginTop: 0 },
  summaryTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text, marginBottom: 8 },
  summaryLine: { fontSize: 15, fontWeight: "600", color: theme.colors.text, lineHeight: 22 },
  summaryMeta: { marginTop: 6, fontSize: 13, color: theme.colors.textMuted },
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
  sessionDeleteConfirm: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  sessionDeleteConfirmTxt: { color: theme.colors.text, fontWeight: "700", fontSize: 14, lineHeight: 20 },
  sessionDeleteConfirmRow: { flexDirection: "row", gap: 10 },
  sessionDeleteConfirmRowRtl: { flexDirection: "row-reverse" },
  sessionDeleteCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
  },
  sessionDeleteCancelTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  sessionDeleteOkBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.error,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  sessionDeleteOkTxt: { color: theme.colors.white, fontWeight: "900", fontSize: 14 },
  editBlock: { marginBottom: theme.spacing.md },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
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
