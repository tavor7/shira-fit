import { useLocalSearchParams, router, Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, Platform, TouchableOpacity } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { AppText } from "../../../../src/components/AppText";
import { AppTextField } from "../../../../src/components/AppTextField";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { MoveParticipantSheet, type MoveParticipantTarget } from "../../../../src/components/MoveParticipantSheet";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay } from "../../../../src/lib/dateFormat";
import { isCancellationWithinHoursBeforeSession, hasSessionNotStarted } from "../../../../src/lib/sessionTime";
import { useToast } from "../../../../src/context/ToastContext";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";
import { KickboxSessionBadge } from "../../../../src/components/KickboxSessionBadge";
import { useAppAlert } from "../../../../src/context/AppAlertContext";
import { useAuth } from "../../../../src/context/AuthContext";
import { useSessionPresence, type PresentStaffMember } from "../../../../src/hooks/useSessionPresence";
import { SessionPresenceBar } from "../../../../src/components/SessionPresenceBar";
import { FadeSlideIn } from "../../../../src/components/FadeSlideIn";
import { AnimatedOptionExpand } from "../../../../src/components/AnimatedOptionExpand";
import { useCountUp } from "../../../../src/hooks/useCountUp";
type W = {
  user_id: string;
  requested_at: string;
  profiles: { full_name: string; phone?: string | null } | { full_name: string; phone?: string | null }[] | null;
};
type CancellationRow = {
  id: string;
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
  const { showOk, showConfirm } = useAppAlert();
  const { showToast } = useToast();
  const { profile } = useAuth();
  const presenceSelf: PresentStaffMember | null =
    profile && (profile.role === "coach" || profile.role === "manager")
      ? { userId: profile.user_id, name: profile.full_name, role: profile.role }
      : null;
  const othersPresent = useSessionPresence(id, presenceSelf);
  const [participantsRev, setParticipantsRev] = useState(0);
  const [participantCount, setParticipantCount] = useState(0);
  const [sessionMaxParticipants, setSessionMaxParticipants] = useState(0);
  const [waitlist, setWaitlist] = useState<W[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<MoveParticipantTarget | null>(null);
  const [coachId, setCoachId] = useState<string | null>(null);
  const [sessionSchedule, setSessionSchedule] = useState<{ session_date: string; start_time: string } | null>(null);
  const [isKickbox, setIsKickbox] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [waitlistQuickUserId, setWaitlistQuickUserId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);

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
      .select("id, user_id, cancelled_at, reason, charged_full_price, profiles(full_name)")
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
        .select("coach_id, session_date, start_time, max_participants, is_kickbox")
        .eq("id", id)
        .single();
      const row = s as {
        coach_id?: string;
        session_date?: string;
        start_time?: string;
        max_participants?: number;
        is_kickbox?: boolean;
      } | null;
      setCoachId(row?.coach_id ?? null);
      setSessionMaxParticipants(Math.max(0, Number(row?.max_participants) || 0));
      setIsKickbox(!!row?.is_kickbox);
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
      showOk(t("common.failed"), data?.error ?? "");
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

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("coach_remove_athlete", { p_session_id: id, p_user_id: userId });
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) {
      setParticipantsRev((n) => n + 1);
    } else showOk(t("common.failed"), data?.error ?? "");
  }

  async function removeManual(manualId: string) {
    const { data, error } = await supabase.rpc("remove_manual_participant_from_session", {
      p_session_id: id,
      p_manual_participant_id: manualId,
    });
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) {
      setParticipantsRev((n) => n + 1);
    } else showOk(t("common.failed"), data?.error ?? "");
  }

  const canEditSession = !!(myId && coachId && myId === coachId);
  const sessionCanMoveParticipants =
    canEditSession &&
    !!(sessionSchedule && hasSessionNotStarted(sessionSchedule.session_date, sessionSchedule.start_time));

  async function quickAddWaitlistedAthlete(userId: string) {
    if (!id || waitlistQuickUserId || !canEditSession) return;
    setWaitlistQuickUserId(userId);
    try {
      const { data, error } = await supabase.rpc("coach_add_athlete", {
        p_session_id: id,
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
        await loadWaitlist();
        setParticipantsRev((n) => n + 1);
        return;
      }
      const code = String(data?.error ?? "");
      if (code === "full") {
        showToast({
          message: t("sessionDetail.sessionFull"),
          detail: t("sessionDetail.sessionFullDetail"),
          variant: "info",
        });
        return;
      }
      showOk(t("common.failed"), code || t("common.failed"));
    } finally {
      setWaitlistQuickUserId(null);
    }
  }

  function afterParticipantsChange() {
    loadWaitlist();
    loadCancellations();
    loadNotes();
  }

  const handleParticipantCountChange = useCallback((n: number) => {
    setParticipantCount(n);
  }, []);

  const preserveScrollPosition = useCallback(() => {
    const y = scrollYRef.current;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y, animated: false });
    });
  }, []);

  const maxCapCoach = Math.max(1, sessionMaxParticipants || 1);
  const displayParticipantCount = Math.round(useCountUp(participantCount));

  return (
    <>
      <Stack.Screen options={{ title: t("screen.coachSession") }} />
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
      {isKickbox ? (
        <View style={styles.kickboxBanner}>
          <KickboxSessionBadge isRTL={isRTL} />
        </View>
      ) : null}
      <AppText variant="title" isRTL={isRTL} style={styles.h}>
        {t("sessionDetail.participantsAttendance")}
        <AppText variant="title" muted style={styles.hMuted}>
          {" "}
          ({displayParticipantCount}/{maxCapCoach})
        </AppText>
      </AppText>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={afterParticipantsChange}
        onParticipantCountChange={handleParticipantCountChange}
        onAttendanceStatsChange={preserveScrollPosition}
        onRemoveAthlete={canEditSession ? removeAthlete : undefined}
        onRemoveManualParticipant={canEditSession ? removeManual : undefined}
        onMoveParticipant={
          sessionCanMoveParticipants
            ? (target) => {
                setMoveTarget(target);
                setMoveOpen(true);
              }
            : undefined
        }
      />

      <AppText variant="title" isRTL={isRTL} style={styles.h}>
        {t("sessionDetail.waitlist")}
      </AppText>
      {waitlist.length === 0 ? (
        <AppText soft isRTL={isRTL}>
          {t("common.none")}
        </AppText>
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
                      accessibilityLabel={t("sessionDetail.quickAddA11y")}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={theme.colors.ctaText} />
                      ) : (
                        <Text style={styles.waitQuickBtnTxt}>{t("common.add")}</Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </FadeSlideIn>
          );
        })
      )}
      {canEditSession ? (
        <PrimaryButton
          label={t("sessionDetail.addParticipant")}
          onPress={() => setAddOpen(true)}
          variant="ghost"
        />
      ) : null}

      <AppText variant="title" isRTL={isRTL} style={styles.h}>
        {t("sessionDetail.cancellations")}
      </AppText>
      {cancellations.length === 0 ? (
        <AppText soft isRTL={isRTL}>
          {t("common.none")}
        </AppText>
      ) : (
        cancellations.map((c, index) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          const sched = sessionSchedule
            ? isCancellationWithinHoursBeforeSession(sessionSchedule.session_date, sessionSchedule.start_time, c.cancelled_at, 12)
            : false;
          return (
            <FadeSlideIn key={c.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={styles.cancelCard}>
                <Text style={styles.cancelName}>{name}</Text>
                <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
                <Text style={styles.cancelReason}>
                  {t("sessionDetail.reasonPrefix")}
                  {c.reason}
                </Text>
                {sched ? (
                  <>
                    <Text style={styles.chargeWarn}>
                      {t("managerSession.lateCancelBadge")}
                    </Text>
                    <Text style={[styles.chargeInfo, isRTL && styles.rtlText]}>
                      {c.charged_full_price === true
                        ? t("managerSession.coachLateFeeCharged")
                        : t("managerSession.coachLateFeeWaived")}
                    </Text>
                  </>
                ) : null}
              </View>
            </FadeSlideIn>
          );
        })
      )}

      <AppText variant="title" isRTL={isRTL} style={styles.h}>
        {t("sessionDetail.notes")}
      </AppText>
      <View style={styles.notesCard}>
        {!noteComposerOpen ? (
          <Pressable
            onPress={() => setNoteComposerOpen(true)}
            style={({ pressed }) => [styles.noteCollapsedTrigger, pressed && { opacity: 0.88 }]}
            accessibilityRole="button"
          >
            <AppText soft isRTL={isRTL} style={styles.noteCollapsedTriggerText}>
              {t("sessionDetail.tapAddNote")}
            </AppText>
          </Pressable>
        ) : null}
        <AnimatedOptionExpand open={noteComposerOpen}>
          <View key={noteComposerOpen ? "open" : "closed"}>
            <AppTextField
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder={t("sessionDetail.addNotePlaceholder")}
              multiline
              autoFocus
              isRTL={isRTL}
              style={styles.noteInputMultiline}
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
        </AnimatedOptionExpand>

        {notes.length === 0 ? (
          <AppText soft isRTL={isRTL} style={styles.noteListHint}>
            {t("sessionDetail.noSavedNotes")}
          </AppText>
        ) : (
          <View style={styles.noteList}>
            {notes.map((n, index) => {
              const p = n.profiles ? (Array.isArray(n.profiles) ? n.profiles[0] : n.profiles) : null;
              const name = p?.full_name ?? n.author_id;
              const canDelete = !!myId && myId === n.author_id;
              const isEditing = editingNoteId === n.id;
              return (
                <FadeSlideIn key={n.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
                <View style={styles.noteRow}>
                  <Text style={[styles.noteMeta, isRTL && styles.rtlText]}>
                    {name} · {formatDateTimeForDisplay(n.created_at, language)}
                  </Text>
                  {!isEditing ? (
                    <Text style={[styles.noteBody, isRTL && styles.rtlText]}>{n.body}</Text>
                  ) : null}
                  <AnimatedOptionExpand open={isEditing}>
                    <View key={isEditing ? "editing" : "idle"}>
                      <AppTextField
                        value={noteEditDraft}
                        onChangeText={setNoteEditDraft}
                        multiline
                        autoFocus
                        isRTL={isRTL}
                        containerStyle={styles.noteEditField}
                        style={styles.noteInputMultiline}
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
                    </View>
                  </AnimatedOptionExpand>
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
                        <Text style={styles.noteEditBtnTxt}>{t("common.edit")}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        delayPressIn={0}
                        onPress={() => void deleteNote(n.id)}
                        {...(Platform.OS === "web" ? ({ onClick: () => void deleteNote(n.id) } as any) : null)}
                        style={[styles.noteDelete, Platform.OS === "web" && styles.noteDeleteWeb]}
                        accessibilityRole="button"
                      >
                        <Text style={styles.noteDeleteTxt}>{t("common.delete")}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
                </FadeSlideIn>
              );
            })}
          </View>
        )}
      </View>

      {canEditSession ? (
        <PrimaryButton
          label={t("sessionDetail.editSession")}
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
      <MoveParticipantSheet
        visible={moveOpen}
        onClose={() => {
          setMoveOpen(false);
          setMoveTarget(null);
        }}
        fromSessionId={String(id ?? "")}
        fromSessionDate={sessionSchedule?.session_date ?? ""}
        fromMaxParticipants={maxCapCoach}
        fromParticipantCount={participantCount}
        participant={moveTarget}
        coachFilterUserId={coachId}
        isManager={false}
        onMoved={() => {
          setParticipantsRev((n) => n + 1);
          afterParticipantsChange();
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
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: theme.spacing.xs },
  kickboxBanner: { marginBottom: theme.spacing.sm },
  h: { marginTop: theme.spacing.md, marginBottom: theme.spacing.sm },
  hMuted: {
    fontSize: 17,
    letterSpacing: 0.15,
  },
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
  noteInputMultiline: { minHeight: 84, textAlignVertical: "top" },
  noteEditField: { marginTop: 6 },
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
