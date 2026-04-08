import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { formatISODateLong } from "../lib/dateFormat";
import type { SessionsWeekItem } from "./SessionsWeekCalendar";
import { supabase } from "../lib/supabase";
import { SessionAgendaCardContent } from "./SessionAgendaCardContent";
import { useI18n } from "../context/I18nContext";
import { appendNetworkHint } from "../lib/networkErrors";
import { DatePickerField } from "./DatePickerField";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";

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
}: Props) {
  const { language, t } = useI18n();
  const title = formatISODateLong(dateIso, language);
  const isStaff = variant === "coach" || variant === "manager";
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupToDate, setDupToDate] = useState<string>("");
  const [undo, setUndo] = useState<UndoAction | null>(null);

  const isManager = variant === "manager";
  const offlineHint = useMemo(() => t("network.offlineHint"), [t]);

  useEffect(() => {
    if (!visible) return;
    setUndo(null);
    if (dupOpen) return;
    const base = parseISODateLocal(dateIso);
    if (!base) return;
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    setDupToDate(toISODateLocal(d));
  }, [visible, dateIso, dupOpen]);

  function confirmDelete(sessionId: string) {
    const msg =
      language === "he"
        ? "למחוק את האימון? גם ההרשמות אליו יימחקו."
        : "Delete this session? Registrations for it will be removed too.";

    const runDelete = async () => {
      setBusyId(sessionId);
      const before = await supabase.from("training_sessions").select("*").eq("id", sessionId).single();
      const sessionRow = before.data as unknown as TrainingSessionRow | null;
      const { error } = await supabase.from("training_sessions").delete().eq("id", sessionId);
      setBusyId(null);
      if (error) {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          window.alert(language === "he" ? `לא ניתן למחוק: ${error.message}` : `Could not delete: ${error.message}`);
        } else {
          Alert.alert(language === "he" ? "לא ניתן למחוק" : "Could not delete", error.message);
        }
        return;
      }
      if (sessionRow) setUndo({ kind: "delete_one", sessions: [sessionRow] });
      onChanged?.();
    };

    // RN Web: multi-button Alert often does not show — use native confirm.
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(msg)) {
        void runDelete();
      }
      return;
    }

    Alert.alert(language === "he" ? "מחיקת אימון?" : "Delete session?", msg, [
      { text: language === "he" ? "ביטול" : "Cancel", style: "cancel" },
      { text: language === "he" ? "מחיקה" : "Delete", style: "destructive", onPress: () => void runDelete() },
    ]);
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
    if (Platform.OS === "web" && typeof window !== "undefined") window.alert(`${titleText}\n${message}`);
    else Alert.alert(titleText, message);
  }

  function confirmClearDay() {
    const msg =
      language === "he"
        ? "למחוק את כל האימונים ביום הזה? גם ההרשמות אליהם יימחקו."
        : "Delete all sessions on this day? Registrations for them will be removed too.";

    const run = async () => {
      setBulkBusy(true);
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
    };

    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(msg)) void run();
      return;
    }
    Alert.alert(language === "he" ? "מחיקת יום?" : "Clear day?", msg, [
      { text: language === "he" ? "ביטול" : "Cancel", style: "cancel" },
      { text: language === "he" ? "מחיקה" : "Delete", style: "destructive", onPress: () => void run() },
    ]);
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdropFill} onPress={onClose} accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          <Text style={styles.sheetSub}>
            {items.length === 0
              ? isStaff
                ? language === "he"
                  ? "אין אימונים מתוכננים."
                  : "No sessions scheduled."
                : language === "he"
                  ? "אין אימונים פתוחים ביום זה."
                  : "No open sessions this day."
              : language === "he"
                ? `${items.length} אימון${items.length === 1 ? "" : "ים"}`
                : `${items.length} session${items.length === 1 ? "" : "s"}`}
          </Text>

          {isStaff && onAddSession ? (
            <Pressable style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.9 }]} onPress={onAddSession}>
              <Text style={styles.addBtnTxt}>{language === "he" ? "+ הוספת אימון" : "+ Add session"}</Text>
            </Pressable>
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

          {isManager ? (
            <View style={styles.dayActions}>
              <Pressable
                style={({ pressed }) => [styles.dayActionBtn, styles.dayActionDanger, pressed && { opacity: 0.9 }]}
                onPress={confirmClearDay}
                disabled={bulkBusy}
              >
                {bulkBusy ? (
                  <ActivityIndicator color={theme.colors.white} size="small" />
                ) : (
                  <Text style={styles.dayActionDangerTxt}>{language === "he" ? "ניקוי יום" : "Clear day"}</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.dayActionBtn, styles.dayActionNeutral, pressed && { opacity: 0.9 }]}
                onPress={() => setDupOpen(true)}
                disabled={bulkBusy}
              >
                <Text style={styles.dayActionNeutralTxt}>{language === "he" ? "שכפול יום…" : "Duplicate day…"}</Text>
              </Pressable>
            </View>
          ) : null}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
            {items.map((it) => {
              const ownAsCoach = variant === "coach" && it.coachId && currentUserId && it.coachId === currentUserId;
              const canEditMeta = variant === "manager" || ownAsCoach;
              const canDelete = variant === "manager" || ownAsCoach;

              return (
                <View key={it.key} style={styles.card}>
                  <View style={styles.cardTop}>
                    <SessionAgendaCardContent item={it} />
                  </View>

                  {variant === "athlete" ? (
                    <Pressable
                      style={({ pressed }) => [styles.primaryTap, pressed && { opacity: 0.9 }]}
                      onPress={() => {
                        it.onPress?.();
                        onClose();
                      }}
                      disabled={!it.onPress}
                    >
                      <Text style={styles.primaryTapTxt}>{language === "he" ? "צפייה באימון" : "View session"}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.rowBtns}>
                      <Pressable
                        style={({ pressed }) => [styles.ghostBtn, pressed && { opacity: 0.85 }]}
                        onPress={() => goEdit(it.key, it.coachId)}
                      >
                        <Text style={styles.ghostBtnTxt}>
                          {canEditMeta
                            ? language === "he"
                              ? "עריכת אימון"
                              : "Edit session"
                            : language === "he"
                              ? "רשימה"
                              : "Roster"}
                        </Text>
                      </Pressable>
                      {canDelete ? (
                        <Pressable
                          style={({ pressed }) => [styles.dangerBtn, pressed && { opacity: 0.85 }]}
                          onPress={() => confirmDelete(it.key)}
                          disabled={busyId === it.key}
                        >
                          {busyId === it.key ? (
                            <ActivityIndicator color={theme.colors.white} size="small" />
                          ) : (
                            <Text style={styles.dangerBtnTxt}>{language === "he" ? "מחיקה" : "Delete"}</Text>
                          )}
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          <Pressable style={({ pressed }) => [styles.closeFooter, pressed && { opacity: 0.85 }]} onPress={onClose}>
            <Text style={styles.closeFooterTxt}>{language === "he" ? "סגור" : "Close"}</Text>
          </Pressable>

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
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: theme.spacing.lg,
    maxHeight: "88%",
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.borderInput,
    marginTop: 10,
    marginBottom: theme.spacing.sm,
  },
  sheetTitle: {
    fontSize: 19,
    fontWeight: "700",
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.lg,
    textAlign: "center",
    letterSpacing: 0.2,
  },
  sheetSub: {
    marginTop: 6,
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: "center",
    paddingHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  addBtn: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    backgroundColor: theme.colors.cta,
    paddingVertical: 15,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  addBtnTxt: { color: theme.colors.ctaText, fontWeight: "700", fontSize: 16, letterSpacing: 0.2 },
  dayActions: { marginHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md, flexDirection: "row", gap: 10 },
  dayActionBtn: {
    flex: 1,
    borderRadius: theme.radius.md,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  dayActionDanger: { backgroundColor: theme.colors.error },
  dayActionDangerTxt: { color: theme.colors.white, fontWeight: "800", fontSize: 14, letterSpacing: 0.2 },
  dayActionNeutral: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.borderMuted },
  dayActionNeutralTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14, letterSpacing: 0.2 },
  undoBar: {
    marginHorizontal: theme.spacing.lg,
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
  list: { maxHeight: 420 },
  listContent: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md, gap: 12 },
  card: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    padding: theme.spacing.md,
  },
  cardTop: { marginBottom: theme.spacing.sm },
  primaryTap: {
    marginTop: 4,
    backgroundColor: theme.colors.cta,
    paddingVertical: 13,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  primaryTapTxt: { color: theme.colors.ctaText, fontWeight: "700", fontSize: 15, letterSpacing: 0.2 },
  rowBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  rowBtnsRtl: { flexDirection: "row-reverse" },
  ghostBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
  },
  ghostBtnTxt: { color: theme.colors.text, fontWeight: "700", fontSize: 14 },
  dangerBtn: {
    flex: 1,
    backgroundColor: theme.colors.error,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 42,
  },
  dangerBtnTxt: { color: theme.colors.white, fontWeight: "700", fontSize: 14 },
  closeFooter: {
    marginTop: theme.spacing.sm,
    marginHorizontal: theme.spacing.lg,
    paddingVertical: 14,
    alignItems: "center",
  },
  closeFooterTxt: { color: theme.colors.textSoft, fontWeight: "600", fontSize: 15 },

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
