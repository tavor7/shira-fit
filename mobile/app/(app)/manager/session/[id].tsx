import { useLocalSearchParams, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
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
import { formatDateTimeForDisplay, formatISODateFull } from "../../../../src/lib/dateFormat";
import { useAuth } from "../../../../src/context/AuthContext";
import { sessionFormIsCompact, sessionFormStyles as sf } from "../../../../src/components/sessionFormStyles";

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

export default function ManagerSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const compact = sessionFormIsCompact(width);
  const [participantsRev, setParticipantsRev] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
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
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);

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
        Alert.alert(t("common.failed"), data?.error ?? "");
        return;
      }
      await loadNotes();
    };
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

  if (!session) return <Text style={[styles.loading, isRTL && styles.rtlText]}>{t("common.loading")}</Text>;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!editingSession ? (
        <View style={styles.summaryBlock}>
          <Text style={[styles.summaryTitle, isRTL && styles.rtlText]}>{language === "he" ? "אימון" : "Session"}</Text>
          <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>
            {formatISODateFull(date, language)} · {time} · {durationMin} {language === "he" ? "דק׳" : "min"} ·{" "}
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

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>{language === "he" ? "סיבה: " : "Reason: "}{c.reason}</Text>
              {c.charged_full_price ? (
                <Text style={styles.chargeWarn}>
                  {language === "he" ? "ביטול מאוחר (<24ש׳) — חיוב" : "Late cancellation (<24h) — charged"}
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
            onPress={() => setNoteComposerOpen(true)}
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
              const canDelete = !!user?.id && user.id === n.author_id;
              return (
                <View key={n.id} style={styles.noteRow}>
                  <Text style={[styles.noteMeta, isRTL && styles.rtlText]}>
                    {name} · {formatDateTimeForDisplay(n.created_at, language)}
                  </Text>
                  <Text style={[styles.noteBody, isRTL && styles.rtlText]}>{n.body}</Text>
                  {canDelete ? (
                    <Pressable style={({ pressed }) => [styles.noteDelete, pressed && { opacity: 0.85 }]} onPress={() => deleteNote(n.id)}>
                      <Text style={styles.noteDeleteTxt}>{language === "he" ? "מחיקה" : "Delete"}</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </View>

      {!editingSession ? (
        <PrimaryButton
          label={language === "he" ? "עריכת אימון" : "Edit session"}
          onPress={() => {
            setNoteComposerOpen(false);
            setNoteDraft("");
            setUndoStack([]);
            setEditingSession(true);
          }}
          variant="ghost"
        />
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
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  loading: { padding: theme.spacing.lg, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  summaryBlock: { marginBottom: theme.spacing.sm },
  summaryTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text, marginBottom: 8 },
  summaryLine: { fontSize: 15, fontWeight: "600", color: theme.colors.text, lineHeight: 22 },
  summaryMeta: { marginTop: 6, fontSize: 13, color: theme.colors.textMuted },
  editBlock: { marginBottom: theme.spacing.md },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  muted: { color: theme.colors.textSoft },
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
  noteDelete: { marginTop: 10, alignSelf: "flex-start" },
  noteDeleteTxt: { color: theme.colors.error, fontWeight: "900" },
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
});
