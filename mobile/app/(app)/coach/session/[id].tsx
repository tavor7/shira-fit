import { useLocalSearchParams, router, Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Alert, TextInput, Pressable, ActivityIndicator, Platform, TouchableOpacity } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay } from "../../../../src/lib/dateFormat";
import { isCancellationWithinHoursBeforeSession } from "../../../../src/lib/sessionTime";
import { useToast } from "../../../../src/context/ToastContext";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";

type W = {
  user_id: string;
  requested_at: string;
  profiles: { full_name: string; phone?: string | null } | { full_name: string; phone?: string | null }[] | null;
};
type CancellationRow = {
  user_id: string;
  cancelled_at: string;
  reason: string;
  charged_full_price: boolean;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

type NoteRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: string;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

export default function CoachSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [participantsRev, setParticipantsRev] = useState(0);
  const [waitlist, setWaitlist] = useState<W[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [coachId, setCoachId] = useState<string | null>(null);
  const [sessionSchedule, setSessionSchedule] = useState<{ session_date: string; start_time: string } | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [waitlistQuickUserId, setWaitlistQuickUserId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const t = requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    return () => cancelAnimationFrame(t);
  }, [id]);

  async function loadWaitlist() {
    const { data: w, error } = await supabase
      .from("waitlist_requests")
      .select("user_id, requested_at, profiles(full_name, phone)")
      .eq("session_id", id)
      .order("requested_at", { ascending: true });
    if (error) {
      setWaitlist([]);
      return;
    }
    setWaitlist((w as unknown as W[]) ?? []);
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

  useEffect(() => {
    loadWaitlist();
    loadCancellations();
    loadNotes();
    void (async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
      setMyId(uid);
      const { data: s } = await supabase
        .from("training_sessions")
        .select("coach_id, session_date, start_time")
        .eq("id", id)
        .single();
      const row = s as { coach_id?: string; session_date?: string; start_time?: string } | null;
      setCoachId(row?.coach_id ?? null);
      if (row?.session_date && row?.start_time) {
        setSessionSchedule({ session_date: row.session_date, start_time: row.start_time });
      } else {
        setSessionSchedule(null);
      }
    })();
  }, [id]);

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
      Alert.alert(t("common.failed"), data?.error ?? "");
      return;
    }
    setEditingNoteId(null);
    setNoteEditDraft("");
    await loadNotes();
  }

  async function deleteNote(noteId: string) {
    const msg = language === "he" ? "למחוק את ההערה?" : "Delete this note?";
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

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("coach_remove_athlete", { p_session_id: id, p_user_id: userId });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
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
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  const canEditSession = !!(myId && coachId && myId === coachId);

  async function quickAddWaitlistedAthlete(userId: string) {
    if (!id || waitlistQuickUserId || !canEditSession) return;
    setWaitlistQuickUserId(userId);
    try {
      const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: id, p_user_id: userId });
      if (error) {
        showToast({ message: t("common.error"), detail: error.message, variant: "error" });
        return;
      }
      if (data?.ok) {
        showToast({
          message: language === "he" ? "נוסף לאימון" : "Added to session",
          variant: "success",
        });
        await loadWaitlist();
        setParticipantsRev((n) => n + 1);
        return;
      }
      const code = String(data?.error ?? "");
      if (code === "full") {
        showToast({
          message: language === "he" ? "האימון מלא" : "Session full",
          detail:
            language === "he"
              ? "רק מנהל יכול להגדיל קיבולת. אפשר להסיר משתתף או לפנות למנהל."
              : "Only a manager can raise capacity. Remove someone or ask a manager.",
          variant: "info",
        });
        return;
      }
      Alert.alert(t("common.failed"), code || t("common.failed"));
    } finally {
      setWaitlistQuickUserId(null);
    }
  }

  function afterParticipantsChange() {
    loadWaitlist();
    loadCancellations();
    loadNotes();
  }

  return (
    <>
      <Stack.Screen options={{ title: t("screen.coachSession") }} />
      <View style={styles.root}>
        <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "משתתפים ונוכחות" : "Participants & attendance"}</Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={afterParticipantsChange}
        onRemoveAthlete={canEditSession ? removeAthlete : undefined}
        onRemoveManualParticipant={canEditSession ? removeManual : undefined}
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
                {canEditSession ? (
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
                ) : null}
              </View>
            </View>
          );
        })
      )}
      {canEditSession ? (
        <PrimaryButton
          label={language === "he" ? "הוספת משתתף" : "Add participant"}
          onPress={() => setAddOpen(true)}
          variant="ghost"
        />
      ) : null}

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          const sched = sessionSchedule
            ? isCancellationWithinHoursBeforeSession(sessionSchedule.session_date, sessionSchedule.start_time, c.cancelled_at, 12)
            : false;
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>
                {language === "he" ? "סיבה: " : "Reason: "}
                {c.reason}
              </Text>
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
              const canDelete = !!myId && myId === n.author_id;
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

      {canEditSession ? (
        <PrimaryButton
          label={language === "he" ? "עריכת אימון" : "Edit session"}
          onPress={() => {
            setNoteComposerOpen(false);
            setNoteDraft("");
            setEditingNoteId(null);
            setNoteEditDraft("");
            router.push(`/(app)/coach/session/manage/${id}`);
          }}
          variant="ghost"
        />
      ) : null}

      <AddParticipantToSessionModal
        sessionId={id}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          afterParticipantsChange();
          setParticipantsRev((n) => n + 1);
        }}
      />
    </ScrollView>
        <SessionAdjacentNav variant="coach" sessionId={String(id ?? "")} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: 4 },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
  rtlText: { textAlign: "right" },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border, color: theme.colors.text },
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
