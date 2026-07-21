import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { formatISODateLong, formatISODateDayMonth } from "../lib/dateFormat";
import type { SessionsWeekItem } from "./SessionsWeekCalendar";
import { supabase } from "../lib/supabase";
import { DaySessionSheetRow } from "./DaySessionSheetRow";
import { AthleteWaitlistInviteStripe, AthleteWaitlistJoinedStripe } from "./AthleteWaitlistInviteStripe";
import { useI18n } from "../context/I18nContext";
import { appendNetworkHint } from "../lib/networkErrors";
import { isSessionInActiveSeries, type SeriesScope } from "../lib/sessionSeries";
import { useAppAlert } from "../context/AppAlertContext";
import { DatePickerField } from "./DatePickerField";
import { DateRangeFormPanel } from "./DateRangeFormPanel";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";
import type { StudioCalendarNote } from "../lib/studioCalendarNotes";
import { studioNoteCoversDate } from "../lib/studioCalendarNotes";
import { studioCalendarNoteAccent } from "../lib/studioCalendarNoteAccent";
import { FadeSlideIn } from "./FadeSlideIn";

export type DaySheetVariant = "athlete" | "coach" | "manager";

type TrainingSessionRow = {
  id: string;
  session_date: string;
  start_time: string;
  coach_id: string;
  max_participants: number;
  is_open_for_registration: boolean;
  duration_minutes?: number | null;
  is_hidden?: boolean | null;
  series_id?: string | null;
  series_detached?: boolean | null;
};

type UndoAction =
  | { kind: "delete_one"; sessions: TrainingSessionRow[] }
  | { kind: "clear_day"; sessions: TrainingSessionRow[] }
  | { kind: "duplicate_day"; createdSessionIds: string[] };

type Props = {
  visible: boolean;
  onClose: () => void;
  dateIso: string;
  items: SessionsWeekItem[];
  variant: DaySheetVariant;
  currentUserId?: string | null;
  onAddSession?: () => void;
  onChanged?: () => void;
  /** Notes overlapping this day (parent supplies week-fetched list). */
  calendarNotes?: StudioCalendarNote[];
  /** After manager edits notes, parent refetches. */
  onCalendarNotesChanged?: () => void;
};

export function DaySessionsSheet({
  visible,
  onClose,
  dateIso,
  items,
  variant,
  currentUserId,
  onAddSession,
  onChanged,
  calendarNotes,
  onCalendarNotesChanged,
}: Props) {
  const { height: winH } = useWindowDimensions();
  const { language, t, isRTL } = useI18n();
  const title = formatISODateLong(dateIso, language);
  const isStaff = variant === "coach" || variant === "manager";
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupToDate, setDupToDate] = useState<string>("");
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [pendingDeleteStudioNoteId, setPendingDeleteStudioNoteId] = useState<string | null>(null);
  const [pendingClearDay, setPendingClearDay] = useState(false);
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [nfTitle, setNfTitle] = useState("");
  const [nfDetail, setNfDetail] = useState("");
  const [nfStart, setNfStart] = useState("");
  const [nfEnd, setNfEnd] = useState("");
  const [nfKind, setNfKind] = useState<"holiday" | "closure" | "info">("holiday");
  const [nfAudience, setNfAudience] = useState<"all" | "athletes" | "staff">("all");
  const [noteBusy, setNoteBusy] = useState(false);
  const isManager = variant === "manager";
  const offlineHint = useMemo(() => t("network.offlineHint"), [t]);
  const { showAlert, showConfirm, showOk } = useAppAlert();

  const dayStudioNotes = useMemo(
    () => (calendarNotes ?? []).filter((n) => studioNoteCoversDate(n, dateIso)),
    [calendarNotes, dateIso]
  );

  useEffect(() => {
    if (!visible) {
      setNoteFormOpen(false);
      setEditingNoteId(null);
      setNoteBusy(false);
      setPendingDeleteStudioNoteId(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    setUndo(null);
    setPendingDeleteStudioNoteId(null);
    setPendingClearDay(false);
    if (dupOpen) return;
    const base = parseISODateLocal(dateIso);
    if (!base) return;
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    setDupToDate(toISODateLocal(d));
  }, [visible, dateIso, dupOpen]);

  async function executeSessionDelete(sessionId: string, scope?: SeriesScope) {
    setBusyId(sessionId);
    const before = await supabase.from("training_sessions").select("*").eq("id", sessionId).single();
    const sessionRow = before.data as unknown as TrainingSessionRow | null;
    let deleteError: { message: string } | null = null;
    if (sessionRow?.series_id) {
      const { data, error } = await supabase.rpc("staff_delete_session_series_scope", {
        p_session_id: sessionId,
        p_scope: scope ?? "this",
      });
      if (error) deleteError = { message: error.message };
      else if (!data?.ok) deleteError = { message: String(data?.error ?? "failed") };
    } else {
      const res = await supabase.from("training_sessions").delete().eq("id", sessionId);
      if (res.error) deleteError = { message: res.error.message };
    }
    setBusyId(null);
    if (deleteError) {
      showOk(language === "he" ? "לא ניתן למחוק" : "Could not delete", deleteError.message);
      return;
    }
    if (sessionRow) setUndo({ kind: "delete_one", sessions: [sessionRow] });
    onChanged?.();
  }

  async function startDeleteFlow(sessionId: string) {
    // Decide if this deletion should create a series exception (so the base occurrence won't respawn).
    const before = await supabase.from("training_sessions").select("id, series_id, series_detached").eq("id", sessionId).single();
    const sessionRow = before.data as unknown as TrainingSessionRow | null;
    const hasSeries = Boolean(sessionRow?.series_id);
    if (!hasSeries) {
      showConfirm({
        title: language === "he" ? "מחיקת אימון?" : "Delete session?",
        message:
          language === "he"
            ? "למחוק את האימון? גם ההרשמות אליו יימחקו."
            : "Delete this session? Registrations for it will be removed too.",
        cancelLabel: language === "he" ? "ביטול" : "Cancel",
        confirmLabel: language === "he" ? "מחק" : "Delete",
        confirmVariant: "danger",
        onConfirm: () => void executeSessionDelete(sessionId),
      });
      return;
    }

    // If session is part of an active series, allow deleting future too; otherwise only delete this.
    const allowFuture = isSessionInActiveSeries({
      series_id: sessionRow?.series_id,
      series_detached: sessionRow?.series_detached ?? false,
    });
    if (allowFuture) {
      showAlert({
        title: language === "he" ? "מחיקת אימון חוזר" : "Delete recurring session",
        message:
          language === "he"
            ? "בחרו פעולה. גם ההרשמות יימחקו."
            : "Choose an action. Registrations will be removed too.",
        actions: [
          { label: language === "he" ? "ביטול" : "Cancel", variant: "secondary", onPress: () => {} },
          {
            label: language === "he" ? "מחק רק אימון זה" : "Delete only this session",
            variant: "danger",
            onPress: () => void executeSessionDelete(sessionId, "this"),
          },
          {
            label: language === "he" ? "מחק אימון זה והבאים" : "Delete this and future",
            variant: "danger",
            onPress: () => void executeSessionDelete(sessionId, "future"),
          },
        ],
      });
    } else {
      showConfirm({
        title: language === "he" ? "מחיקת אימון?" : "Delete session?",
        message:
          language === "he"
            ? "למחוק רק את האימון הזה? גם ההרשמות יימחקו."
            : "Delete only this session? Registrations will be removed too.",
        cancelLabel: language === "he" ? "ביטול" : "Cancel",
        confirmLabel: language === "he" ? "מחק" : "Delete",
        confirmVariant: "danger",
        onConfirm: () => void executeSessionDelete(sessionId, "this"),
      });
    }
  }

  function confirmDelete(sessionId: string) {
    // Single-step delete UX:
    // - If this belongs to a recurring series, ask scope (this vs this+future) immediately.
    // - Otherwise, show a normal confirm.
    void startDeleteFlow(sessionId);
  }

  function goEdit(sessionId: string, coachId?: string) {
    onClose();
    if (variant === "manager") {
      router.push(`/(app)/manager/session/${sessionId}`);
      return;
    }
    if (variant === "coach") {
      if (coachId && currentUserId && coachId === currentUserId) {
        router.push(`/(app)/coach/session/manage/${sessionId}`);
      } else {
        router.push(`/(app)/coach/session/${sessionId}`);
      }
    }
  }

  function showError(titleText: string, message: string) {
    showOk(titleText, message);
  }

  async function executeClearDay() {
    setBulkBusy(true);
    setPendingClearDay(false);
    const before = await supabase.from("training_sessions").select("*").eq("session_date", dateIso);
    const { data, error } = await supabase.rpc("manager_clear_sessions_for_day", { p_date: dateIso });
    setBulkBusy(false);
    if (error) {
      showError(language === "he" ? "לא ניתן למחוק" : "Could not clear day", appendNetworkHint(error, offlineHint));
      return;
    }
    if (!data?.ok) {
      showError(language === "he" ? "לא ניתן למחוק" : "Could not clear day", data?.error ?? "");
      return;
    }
    const sessions = (before.data as unknown as TrainingSessionRow[]) ?? [];
    if (sessions.length) setUndo({ kind: "clear_day", sessions });
    onChanged?.();
    onClose();
  }

  function confirmClearDay() {
    const msg =
      language === "he"
        ? "למחוק את כל האימונים ביום הזה? גם ההרשמות אליהם יימחקו."
        : "Delete all sessions on this day? Registrations for them will be removed too.";

    if (Platform.OS === "web") {
      setPendingClearDay(true);
      return;
    }
    showConfirm({
      title: language === "he" ? "מחיקת יום?" : "Clear day?",
      message: msg,
      cancelLabel: language === "he" ? "ביטול" : "Cancel",
      confirmLabel: language === "he" ? "מחיקה" : "Delete",
      confirmVariant: "danger",
      onConfirm: () => void executeClearDay(),
    });
  }

  async function runDuplicateDay() {
    if (!dupToDate || dupToDate === dateIso) {
      showError(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך יעד שונה." : "Please choose a different target date."
      );
      return;
    }
    setBulkBusy(true);
    const { data, error } = await supabase.rpc("manager_duplicate_sessions_day", {
      p_from_date: dateIso,
      p_to_date: dupToDate,
    });
    setBulkBusy(false);
    if (error) {
      showError(language === "he" ? "לא ניתן לשכפל" : "Could not duplicate", appendNetworkHint(error, offlineHint));
      return;
    }
    if (!data?.ok) {
      const code = String(data?.error ?? "");
      const msg =
        code === "target_not_empty"
          ? language === "he"
            ? "כבר קיימים אימונים בתאריך היעד. (כדי למנוע כפילויות לא שוכפל.)"
            : "Target date already has sessions. (Not duplicated to avoid duplicates.)"
          : code === "same_day"
            ? language === "he"
              ? "בחרו יום יעד אחר."
              : "Please choose a different target date."
            : code;
      showError(language === "he" ? "לא ניתן לשכפל" : "Could not duplicate", msg);
      return;
    }
    // Capture created IDs so we can undo by deleting them.
    const createdList = await supabase.from("training_sessions").select("id").eq("session_date", dupToDate);
    const createdIds = ((createdList.data as unknown as { id: string }[]) ?? []).map((r) => r.id);
    if (createdIds.length) setUndo({ kind: "duplicate_day", createdSessionIds: createdIds });
    setDupOpen(false);
    onChanged?.();
    onClose();
  }

  async function undoLastAction() {
    if (!undo) return;
    setBulkBusy(true);
    try {
      if (undo.kind === "duplicate_day") {
        if (undo.createdSessionIds.length) {
          const { error } = await supabase.from("training_sessions").delete().in("id", undo.createdSessionIds);
          if (error) throw error;
        }
      } else {
        const rows = undo.sessions;
        if (rows.length) {
          // Re-insert the same IDs (restores schedule; participants are already deleted by cascade).
          const { error } = await supabase.from("training_sessions").insert(rows);
          if (error) throw error;
        }
      }
      setUndo(null);
      onChanged?.();
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message?: unknown }).message) : String(e);
      showError(language === "he" ? "לא ניתן לבטל" : "Could not undo", appendNetworkHint(msg, offlineHint));
    } finally {
      setBulkBusy(false);
    }
  }

  function kindTKey(kind: string) {
    if (kind === "closure") return "calendarNotes.kindClosure";
    if (kind === "info") return "calendarNotes.kindInfo";
    return "calendarNotes.kindHoliday";
  }

  function audienceTKey(aud: string) {
    if (aud === "athletes") return "calendarNotes.audienceAthletes";
    if (aud === "staff") return "calendarNotes.audienceStaff";
    return "calendarNotes.audienceAll";
  }

  function resetNoteFormForNew() {
    setEditingNoteId(null);
    setNfTitle("");
    setNfDetail("");
    setNfStart(dateIso);
    setNfEnd(dateIso);
    setNfKind("holiday");
    setNfAudience("all");
  }

  function openAddStudioNote() {
    resetNoteFormForNew();
    setNoteFormOpen(true);
  }

  function openEditStudioNote(n: StudioCalendarNote) {
    setEditingNoteId(n.id);
    setNfTitle(n.title);
    setNfDetail(n.detail ?? "");
    setNfStart(n.start_date);
    setNfEnd(n.end_date);
    setNfKind(n.kind);
    setNfAudience(n.audience);
    setNoteFormOpen(true);
  }

  async function saveStudioNote() {
    if (!nfTitle.trim()) {
      showError(t("common.error"), t("calendarNotes.validationTitle"));
      return;
    }
    if (nfStart > nfEnd) {
      showError(t("common.error"), t("calendarNotes.validationDates"));
      return;
    }
    setNoteBusy(true);
    const row = {
      title: nfTitle.trim(),
      detail: nfDetail.trim() || null,
      start_date: nfStart,
      end_date: nfEnd,
      kind: nfKind,
      audience: nfAudience,
    };
    const res = editingNoteId
      ? await supabase.from("studio_calendar_notes").update(row).eq("id", editingNoteId)
      : await supabase.from("studio_calendar_notes").insert(row);
    setNoteBusy(false);
    if (res.error) {
      showError(t("common.error"), appendNetworkHint(res.error, offlineHint));
      return;
    }
    setNoteFormOpen(false);
    setEditingNoteId(null);
    onCalendarNotesChanged?.();
  }

  function confirmDeleteStudioNote(id: string) {
    if (Platform.OS === "web") {
      setPendingDeleteStudioNoteId(id);
      return;
    }
    showConfirm({
      title: t("calendarNotes.deleteTitle"),
      message: t("calendarNotes.deleteMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("calendarNotes.removeNote"),
      confirmVariant: "danger",
      onConfirm: () => void executeDeleteStudioNote(id),
    });
  }

  async function executeDeleteStudioNote(id: string) {
    setNoteBusy(true);
    const { error } = await supabase.from("studio_calendar_notes").delete().eq("id", id);
    setNoteBusy(false);
    setPendingDeleteStudioNoteId(null);
    if (error) {
      showError(t("common.error"), appendNetworkHint(error, offlineHint));
      return;
    }
    onCalendarNotesChanged?.();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdropFill} onPress={onClose} accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"} />
        <View style={styles.sheet}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            style={{ maxHeight: Math.min(winH * 0.88, winH - 16) }}
            contentContainerStyle={styles.sheetBodyContent}
          >
            <View style={styles.sheetHeader}>
              <View style={styles.handle} />
              <View style={[styles.titleRow, isRTL && styles.titleRowRtl]}>
                <View style={styles.titleBlock}>
                  <Text style={[styles.sheetTitle, isRTL && styles.rtlText]}>{title}</Text>
                  {items.length > 0 ? (
                    <Text style={[styles.sessionCount, isRTL && styles.rtlText]}>
                      {language === "he"
                        ? `${items.length} אימונים`
                        : `${items.length} session${items.length === 1 ? "" : "s"}`}
                    </Text>
                  ) : (
                    <Text style={[styles.sessionCount, isRTL && styles.rtlText]}>
                      {isStaff
                        ? language === "he"
                          ? "אין אימונים"
                          : "No sessions"
                        : language === "he"
                          ? "אין אימונים פתוחים"
                          : "No open sessions"}
                    </Text>
                  )}
                </View>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.75 }]}
                  accessibilityRole="button"
                  accessibilityLabel={language === "he" ? "סגור" : "Close"}
                  hitSlop={12}
                >
                  <Text style={styles.closeBtnTxt}>✕</Text>
                </Pressable>
              </View>
            </View>

            {isStaff && onAddSession ? (
              <Pressable
                style={({ pressed }) => [styles.addSessionCta, pressed && { opacity: 0.92 }]}
                onPress={onAddSession}
              >
                <Text style={styles.addSessionCtaTxt}>
                  {language === "he" ? "הוספת אימון" : "Add session"}
                </Text>
              </Pressable>
            ) : null}

            {dayStudioNotes.length > 0 ? (
              <View style={styles.studioNotesWrap}>
                <Text style={[styles.studioNotesHeading, isRTL && styles.rtlText]}>{t("calendarNotes.sectionTitle")}</Text>
                {dayStudioNotes.map((n) => (
                  <View
                    key={n.id}
                    style={[styles.studioNoteCard, { borderColor: studioCalendarNoteAccent(n.kind).border }]}
                  >
                    <View style={[styles.studioNoteTop, isRTL && styles.studioNoteTopRtl]}>
                      <Text style={[styles.studioNoteEyebrow, isRTL && styles.rtlText]} numberOfLines={1}>
                        {t(kindTKey(n.kind))}, {t(audienceTKey(n.audience))}
                      </Text>
                      {isManager ? (
                        <View style={[styles.studioNoteActions, isRTL && styles.studioNoteActionsRtl]}>
                          <Pressable
                            onPress={() => openEditStudioNote(n)}
                            style={({ pressed }) => [styles.studioNoteMiniBtn, pressed && { opacity: 0.85 }]}
                            disabled={noteBusy || (Platform.OS === "web" && pendingDeleteStudioNoteId === n.id)}
                          >
                            <Text style={styles.studioNoteMiniBtnTxt}>{t("calendarNotes.editNote")}</Text>
                          </Pressable>
                          {!(Platform.OS === "web" && pendingDeleteStudioNoteId === n.id) ? (
                            <Pressable
                              onPress={() => confirmDeleteStudioNote(n.id)}
                              style={({ pressed }) => [styles.studioNoteMiniBtnDanger, pressed && { opacity: 0.85 }]}
                              disabled={noteBusy}
                            >
                              <Text style={styles.studioNoteMiniBtnDangerTxt}>{t("calendarNotes.removeNote")}</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                    {Platform.OS === "web" && isManager && pendingDeleteStudioNoteId === n.id ? (
                      <View style={styles.webConfirmBanner}>
                        <Text style={[styles.webConfirmTxt, isRTL && styles.rtlText]}>
                          {`${t("calendarNotes.deleteTitle")}\n${t("calendarNotes.deleteMessage")}`}
                        </Text>
                        <View style={styles.webConfirmBtns}>
                          <Pressable
                            style={({ pressed }) => [styles.webConfirmGhost, pressed && { opacity: 0.88 }]}
                            onPress={() => setPendingDeleteStudioNoteId(null)}
                            disabled={noteBusy}
                          >
                            <Text style={styles.webConfirmGhostTxt}>{t("common.cancel")}</Text>
                          </Pressable>
                          <Pressable
                            style={({ pressed }) => [styles.webConfirmDanger, pressed && { opacity: 0.9 }]}
                            onPress={() => void executeDeleteStudioNote(n.id)}
                            disabled={noteBusy}
                          >
                            {noteBusy ? (
                              <ActivityIndicator color={theme.colors.white} size="small" />
                            ) : (
                              <Text style={styles.webConfirmDangerTxt}>{t("calendarNotes.removeNote")}</Text>
                            )}
                          </Pressable>
                        </View>
                      </View>
                    ) : null}
                    <Text style={styles.studioNoteTitle}>{n.title}</Text>
                    {n.start_date !== n.end_date ? (
                      <Text style={[styles.studioNoteRange, isRTL && styles.rtlText]}>
                        {t("calendarNotes.rangeThrough")
                          .replace("{start}", formatISODateDayMonth(n.start_date, language))
                          .replace("{end}", formatISODateDayMonth(n.end_date, language))}
                      </Text>
                    ) : null}
                    {n.detail?.trim() ? (
                      <Text style={[styles.studioNoteDetail, isRTL && styles.rtlText]}>{n.detail.trim()}</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}

            {items.length > 0 ? (
              <View style={styles.sessionList}>
                {items.map((it, index) => {
                  const ownAsCoach = variant === "coach" && it.coachId && currentUserId && it.coachId === currentUserId;
                  const canDelete = !!(variant === "manager" || ownAsCoach);

                  return (
                    <FadeSlideIn key={it.key} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
                      {variant === "athlete" && typeof it.onJoinWaitlist === "function" ? (
                        <View style={styles.waitlistBlock}>
                          <AthleteWaitlistInviteStripe
                            onPress={() => void Promise.resolve(it.onJoinWaitlist?.())}
                            joining={it.waitlistJoining}
                          />
                        </View>
                      ) : variant === "athlete" &&
                        it.athleteOnWaitlist === true &&
                        (it.maxParticipants ?? 0) > 0 &&
                        (it.signedUpCount ?? 0) >= (it.maxParticipants ?? 0) ? (
                        <View style={styles.waitlistBlock}>
                          <AthleteWaitlistJoinedStripe />
                        </View>
                      ) : null}
                      <DaySessionSheetRow
                        item={it}
                        isRTL={isRTL}
                        canDelete={canDelete}
                        deleting={busyId === it.key}
                        onDelete={canDelete ? () => confirmDelete(it.key) : undefined}
                        onPress={() => {
                          if (variant === "athlete") {
                            it.onPress?.();
                            onClose();
                          } else {
                            goEdit(it.key, it.coachId);
                          }
                        }}
                      />
                    </FadeSlideIn>
                  );
                })}
              </View>
            ) : null}

            {isManager && noteFormOpen ? (
              <View style={styles.studioNoteForm}>
                <Text style={[styles.studioNoteFormLabel, isRTL && styles.rtlText]}>{t("calendarNotes.fieldTitle")}</Text>
                <TextInput
                  value={nfTitle}
                  onChangeText={setNfTitle}
                  style={[styles.studioNoteInput, styles.studioNoteInputTitle]}
                  placeholderTextColor={theme.colors.placeholderOnLight}
                  editable={!noteBusy}
                />
                <Text style={[styles.studioNoteFormLabel, isRTL && styles.rtlText]}>{t("calendarNotes.fieldDetail")}</Text>
                <TextInput
                  value={nfDetail}
                  onChangeText={setNfDetail}
                  style={[styles.studioNoteInput, styles.studioNoteInputMulti, isRTL && styles.rtlText]}
                  multiline
                  placeholderTextColor={theme.colors.placeholderOnLight}
                  editable={!noteBusy}
                />
                <DateRangeFormPanel
                  fromLabel={t("calendarNotes.fieldStart")}
                  toLabel={t("calendarNotes.fieldEnd")}
                  start={nfStart}
                  end={nfEnd}
                  onStartChange={setNfStart}
                  onEndChange={setNfEnd}
                />
                <Text style={[styles.studioNoteFormLabel, isRTL && styles.rtlText]}>{t("calendarNotes.fieldKind")}</Text>
                <View style={[styles.chipRow, isRTL && styles.chipRowRtl]}>
                  {(["holiday", "closure", "info"] as const).map((k) => {
                    const acc = studioCalendarNoteAccent(k);
                    return (
                      <Pressable
                        key={k}
                        onPress={() => setNfKind(k)}
                        style={({ pressed }) => [
                          styles.chip,
                          nfKind === k && [styles.chipKindOn, { borderColor: acc.border }],
                          pressed && { opacity: 0.88 },
                        ]}
                      >
                        <Text style={[styles.chipTxt, nfKind === k && styles.chipTxtOn]}>{t(kindTKey(k))}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={[styles.studioNoteFormLabel, isRTL && styles.rtlText]}>{t("calendarNotes.fieldAudience")}</Text>
                <View style={[styles.chipRow, isRTL && styles.chipRowRtl]}>
                  {(["all", "athletes", "staff"] as const).map((a) => (
                    <Pressable
                      key={a}
                      onPress={() => setNfAudience(a)}
                      style={({ pressed }) => [
                        styles.chip,
                        nfAudience === a && styles.chipOn,
                        pressed && { opacity: 0.88 },
                      ]}
                    >
                      <Text style={[styles.chipTxt, nfAudience === a && styles.chipTxtOn]}>{t(audienceTKey(a))}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  style={({ pressed }) => [styles.studioNoteSaveBtn, pressed && { opacity: 0.9 }, noteBusy && { opacity: 0.6 }]}
                  onPress={() => void saveStudioNote()}
                  disabled={noteBusy}
                >
                  {noteBusy ? (
                    <ActivityIndicator color={theme.colors.ctaText} size="small" />
                  ) : (
                    <Text style={styles.studioNoteSaveBtnTxt}>{t("calendarNotes.save")}</Text>
                  )}
                </Pressable>
              </View>
            ) : null}

            {isManager && undo ? (
              <View style={styles.undoBar}>
                <Text style={styles.undoBarTxt} numberOfLines={1} ellipsizeMode="tail">
                  {language === "he" ? "בוצעה פעולה." : "Action completed."}
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.undoBarBtn, pressed && { opacity: 0.9 }, bulkBusy && { opacity: 0.6 }]}
                  onPress={() => void undoLastAction()}
                  disabled={bulkBusy}
                >
                  <Text style={styles.undoBarBtnTxt}>{language === "he" ? "ביטול" : "Undo"}</Text>
                </Pressable>
              </View>
            ) : null}

            {isManager && Platform.OS === "web" && pendingClearDay ? (
              <View style={styles.webConfirmBanner}>
                <Text style={[styles.webConfirmTxt, isRTL && styles.rtlText]}>
                  {language === "he"
                    ? "למחוק את כל האימונים ביום? ההרשמות יימחקו."
                    : "Delete all sessions this day? Registrations will be removed."}
                </Text>
                <View style={styles.webConfirmBtns}>
                  <Pressable
                    style={({ pressed }) => [styles.webConfirmGhost, pressed && { opacity: 0.88 }]}
                    onPress={() => setPendingClearDay(false)}
                    disabled={bulkBusy}
                  >
                    <Text style={styles.webConfirmGhostTxt}>{language === "he" ? "ביטול" : "Cancel"}</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.webConfirmDanger, pressed && { opacity: 0.9 }]}
                    onPress={() => void executeClearDay()}
                    disabled={bulkBusy}
                  >
                    {bulkBusy ? (
                      <ActivityIndicator color={theme.colors.white} size="small" />
                    ) : (
                      <Text style={styles.webConfirmDangerTxt}>{language === "he" ? "מחק הכל" : "Delete all"}</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : null}

            {/* Confirmations are handled via AppAlertContext (floating dialog). */}

            {isManager ? (
              <View style={styles.dayToolsBlock}>
                <View style={[styles.dayToolsRow, isRTL && styles.dayToolsRowRtl]}>
                  <Pressable
                    onPress={() => setDupOpen(true)}
                    disabled={bulkBusy}
                    style={({ pressed }) => [
                      styles.dayToolChip,
                      onCalendarNotesChanged ? styles.dayToolChipHalf : styles.dayToolChipFull,
                      pressed && styles.dayToolChipPressed,
                    ]}
                  >
                    <Text style={styles.dayToolChipTxt} numberOfLines={1}>
                      {language === "he" ? "שכפול יום" : "Duplicate day"}
                    </Text>
                  </Pressable>
                  {onCalendarNotesChanged ? (
                    <Pressable
                      onPress={() => (noteFormOpen ? setNoteFormOpen(false) : openAddStudioNote())}
                      disabled={noteBusy}
                      style={({ pressed }) => [styles.dayToolChip, styles.dayToolChipHalf, pressed && styles.dayToolChipPressed]}
                    >
                      <Text style={styles.dayToolChipTxt} numberOfLines={1}>
                        {noteFormOpen ? t("calendarNotes.cancelForm") : t("calendarNotes.addNote")}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <Pressable
                  onPress={confirmClearDay}
                  disabled={bulkBusy || pendingClearDay}
                  style={({ pressed }) => [
                    styles.dayToolChip,
                    styles.dayToolChipDanger,
                    pressed && styles.dayToolChipPressed,
                  ]}
                >
                  <Text style={styles.dayToolChipDangerTxt} numberOfLines={1}>
                    {language === "he" ? "ניקוי כל האימונים ביום" : "Clear all sessions this day"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>

          <Modal visible={dupOpen} transparent animationType="fade" onRequestClose={() => setDupOpen(false)}>
            <View style={styles.dupModalRoot}>
              <Pressable
                style={styles.dupBackdrop}
                onPress={() => setDupOpen(false)}
                accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
              />
              <View style={styles.dupCard}>
                <Text style={styles.dupTitle}>{language === "he" ? "שכפול כל האימונים ליום אחר" : "Duplicate all sessions to another day"}</Text>
                <Text style={styles.dupSub}>
                  {language === "he"
                    ? "האימונים ישוכפלו בלי נרשמים ועם הרשמה סגורה (ייפתח לפי חוק פתיחת ההרשמה השבועי)."
                    : "Sessions will be duplicated without participants and with registration closed (opens by weekly opening rule)."}
                </Text>
                <DatePickerField
                  label={language === "he" ? "תאריך יעד" : "Target date"}
                  value={dupToDate}
                  onChange={setDupToDate}
                />
                <View style={styles.dupBtns}>
                  <Pressable style={({ pressed }) => [styles.dupGhost, pressed && { opacity: 0.9 }]} onPress={() => setDupOpen(false)}>
                    <Text style={styles.dupGhostTxt}>{language === "he" ? "ביטול" : "Cancel"}</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.dupCta, pressed && { opacity: 0.9 }]}
                    onPress={() => void runDuplicateDay()}
                    disabled={bulkBusy}
                  >
                    {bulkBusy ? (
                      <ActivityIndicator color={theme.colors.ctaText} size="small" />
                    ) : (
                      <Text style={styles.dupCtaTxt}>{language === "he" ? "שכפול" : "Duplicate"}</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
    position: "relative",
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  sheet: {
    zIndex: 2,
    position: "relative",
    backgroundColor: theme.colors.backgroundAlt,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: 0,
    overflow: "hidden",
  },
  sheetBodyContent: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl + 8,
  },
  sheetHeader: {
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 4,
  },
  titleRowRtl: { flexDirection: "row-reverse" },
  titleBlock: { flex: 1, minWidth: 0 },
  sessionCount: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textSoft,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  closeBtnTxt: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  addSessionCta: {
    marginBottom: theme.spacing.md,
    backgroundColor: theme.colors.cta,
    paddingVertical: 14,
    borderRadius: theme.radius.full,
    alignItems: "center",
  },
  addSessionCtaTxt: {
    color: theme.colors.ctaText,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.2,
  },
  dayToolsBlock: {
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    gap: 8,
  },
  dayToolsRow: {
    flexDirection: "row",
    gap: 8,
  },
  dayToolsRowRtl: { flexDirection: "row-reverse" },
  dayToolChip: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  dayToolChipHalf: { flex: 1, minWidth: 0 },
  dayToolChipFull: { alignSelf: "stretch" },
  dayToolChipDanger: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  dayToolChipPressed: { opacity: 0.88 },
  dayToolChipTxt: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.text,
    textAlign: "center",
  },
  dayToolChipDangerTxt: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.error,
    textAlign: "center",
  },
  sessionList: { gap: 8, marginBottom: theme.spacing.xs },
  waitlistBlock: { marginBottom: 6 },
  rtlText: { textAlign: "right" },
  webConfirmBanner: {
    marginBottom: theme.spacing.md,
    padding: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
    gap: 10,
  },
  webConfirmTxt: { color: theme.colors.text, fontWeight: "700", fontSize: 14, lineHeight: 20 },
  webConfirmBtns: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  webConfirmGhost: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  webConfirmGhostTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  webConfirmDanger: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.error,
    minWidth: 100,
    alignItems: "center",
  },
  webConfirmDangerTxt: { color: theme.colors.white, fontWeight: "800", fontSize: 14 },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.borderInput,
    marginTop: 8,
    marginBottom: theme.spacing.md,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
  deleteBanner: {
    marginBottom: theme.spacing.sm,
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    gap: 8,
  },
  deleteBannerTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.text, textAlign: "center" },
  deleteBannerRow: { flexDirection: "row", justifyContent: "center", gap: 20 },
  deleteBannerRowRtl: { flexDirection: "row-reverse" },
  deleteBannerCancel: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 14 },
  deleteBannerOk: { color: theme.colors.error, fontWeight: "800", fontSize: 14 },
  undoBar: {
    marginBottom: theme.spacing.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  undoBarTxt: { flex: 1, minWidth: 0, color: theme.colors.text, fontWeight: "700" },
  undoBarBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.cta },
  undoBarBtnTxt: { color: theme.colors.ctaText, fontWeight: "900" },
  studioNotesWrap: {
    marginBottom: theme.spacing.sm,
    gap: 8,
  },
  studioNotesHeading: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  studioNoteCard: {
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    gap: 4,
  },
  studioNoteTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  studioNoteTopRtl: { flexDirection: "row-reverse" },
  studioNoteEyebrow: { flex: 1, fontSize: 11, fontWeight: "800", color: theme.colors.textMuted },
  studioNoteActions: { flexDirection: "row", gap: 6 },
  studioNoteActionsRtl: { flexDirection: "row-reverse" },
  studioNoteMiniBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  studioNoteMiniBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.cta },
  studioNoteMiniBtnDanger: { paddingVertical: 4, paddingHorizontal: 8 },
  studioNoteMiniBtnDangerTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.error },
  studioNoteTitle: { fontSize: 15, fontWeight: "900", color: theme.colors.text, textAlign: "center", width: "100%" },
  studioNoteRange: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
  studioNoteDetail: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textMuted, fontWeight: "600" },
  studioNoteManagerBar: { marginBottom: theme.spacing.sm },
  studioNoteAddBtn: {
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
  },
  studioNoteAddBtnTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  studioNoteForm: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  studioNoteFormLabel: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, marginTop: 4 },
  studioNoteInput: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 10,
    fontSize: 15,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceElevated,
  },
  studioNoteInputTitle: { textAlign: "center", fontWeight: "800" },
  studioNoteInputMulti: { minHeight: 72, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipRowRtl: { flexDirection: "row-reverse" },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  chipOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surfaceElevated },
  chipKindOn: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 2 },
  chipTxt: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  chipTxtOn: { color: theme.colors.text },
  studioNoteSaveBtn: {
    marginTop: 8,
    backgroundColor: theme.colors.cta,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  studioNoteSaveBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 14 },

  dupModalRoot: { flex: 1, justifyContent: "center", padding: theme.spacing.lg },
  dupBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  dupCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.lg,
  },
  dupTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text, textAlign: "center" },
  dupSub: { marginTop: 6, fontSize: 13, color: theme.colors.textMuted, textAlign: "center" },
  dupBtns: { flexDirection: "row", gap: 10, marginTop: theme.spacing.md },
  dupGhost: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
  },
  dupGhostTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  dupCta: { flex: 1, backgroundColor: theme.colors.cta, paddingVertical: 12, borderRadius: theme.radius.md, alignItems: "center" },
  dupCtaTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 14, letterSpacing: 0.2 },
});
