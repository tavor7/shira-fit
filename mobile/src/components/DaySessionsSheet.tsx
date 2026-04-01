import { useState } from "react";
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

export type DaySheetVariant = "athlete" | "coach" | "manager";

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

  function confirmDelete(sessionId: string) {
    const msg =
      language === "he"
        ? "למחוק את האימון? גם ההרשמות אליו יימחקו."
        : "Delete this session? Registrations for it will be removed too.";

    const runDelete = async () => {
      setBusyId(sessionId);
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
});
