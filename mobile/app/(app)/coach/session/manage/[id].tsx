import { useLocalSearchParams, router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ActivityIndicator, ScrollView, useWindowDimensions, Modal, Platform } from "react-native";
import { supabase } from "../../../../../src/lib/supabase";
import type { TrainingSession } from "../../../../../src/types/database";
import { theme } from "../../../../../src/theme";
import { PrimaryButton } from "../../../../../src/components/PrimaryButton";
import { DatePickerField } from "../../../../../src/components/DatePickerField";
import { TimePickerField } from "../../../../../src/components/TimePickerField";
import { isMissingColumnError } from "../../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../../src/lib/isoDate";
import { useI18n } from "../../../../../src/context/I18nContext";
import { sessionFormIsCompact, sessionFormStyles as sf } from "../../../../../src/components/sessionFormStyles";
import { useToast } from "../../../../../src/context/ToastContext";
import { copySessionParticipantsToNewSession } from "../../../../../src/lib/copySessionParticipants";

type EditSnapshot = {
  date: string;
  time: string;
  maxP: string;
  durationMin: string;
  open: boolean;
  hidden: boolean;
};

export default function CoachSessionManageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { width } = useWindowDimensions();
  const compact = sessionFormIsCompact(width);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
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

  function pushUndo() {
    setUndoStack((prev) => {
      const snap: EditSnapshot = { date, time, maxP, durationMin, open, hidden };
      const head = prev[prev.length - 1];
      if (
        head &&
        head.date === snap.date &&
        head.time === snap.time &&
        head.maxP === snap.maxP &&
        head.durationMin === snap.durationMin &&
        head.open === snap.open &&
        head.hidden === snap.hidden
      ) {
        return prev;
      }
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
      setMaxP(snap.maxP);
      setDurationMin(snap.durationMin);
      setOpen(snap.open);
      setHidden(snap.hidden);
      return prev.slice(0, -1);
    });
  }

  useEffect(() => {
    (async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      const { data: s } = await supabase.from("training_sessions").select("*").eq("id", id).single();
      if (!s) {
        setSession(null);
        setForbidden(false);
        setReady(true);
        return;
      }
      if (!uid || s.coach_id !== uid) {
        setForbidden(true);
        setSession(s as TrainingSession);
        setReady(true);
        return;
      }
      setSession(s as TrainingSession);
      setDate(s.session_date);
      setTime(s.start_time);
      setMaxP(String(s.max_participants));
      setDurationMin(String(s.duration_minutes ?? 60));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
      setUndoStack([]);
      setForbidden(false);
      setReady(true);
    })();
  }, [id]);

  async function saveSession() {
    if (!isValidISODateString(date.trim())) {
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    const payload = {
      session_date: date.trim(),
      start_time: time,
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
    router.replace("/(app)/coach/sessions");
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
    if (!session) return;
    const d = dupDate.trim();
    if (!isValidISODateString(d)) {
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    setDupBusy(true);
    const payload = {
      session_date: d,
      start_time: dupTime || time,
      coach_id: session.coach_id,
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
    if (newId && dupIncludeParticipants && id) {
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
    if (newId) router.push(`/(app)/coach/session/${newId}`);
    else router.replace("/(app)/coach/sessions");
  }

  if (forbidden) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <View style={sf.screen}>
        <Text style={[styles.err, isRTL && styles.rtlText]}>
          {language === "he"
            ? "אפשר לערוך רק אימונים שבהם אתה/את המאמן/ת."
            : "You can only edit sessions where you are the trainer."}
        </Text>
      </View>
      </>
    );
  }

  if (!ready) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <View style={sf.screen}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
        <View style={sf.screen}>
          <Text style={[styles.err, isRTL && styles.rtlText]}>{language === "he" ? "האימון לא נמצא." : "Session not found."}</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <ScrollView style={sf.screen} contentContainerStyle={sf.content} keyboardShouldPersistTaps="handled">
      <View style={sf.card}>
        <Text style={[sf.cardTitle, isRTL && { textAlign: "right" }]}>{language === "he" ? "עריכה" : "Edit"}</Text>
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
            {language === "he"
              ? "מוסתר (צוות בלבד, ללא הרשמה עצמית): "
              : "Hidden (staff-only, no athlete self-register): "}
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
        <PrimaryButton
          label={language === "he" ? "שכפול אימון…" : "Duplicate session…"}
          onPress={() => {
            setDupDate(date);
            setDupTime(time);
            setDupIncludeParticipants(false);
            setDupOpen(true);
          }}
          variant="ghost"
        />
        <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.cancelEdit, pressed && { opacity: 0.85 }]}>
          <Text style={styles.cancelEditTxt}>{t("common.cancel")}</Text>
        </Pressable>
      </View>

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
    </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right" },
  toggleRtl: { alignItems: "flex-end" },
  toggleTextRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch", width: "100%" },
  undoBtn: {
    marginBottom: theme.spacing.sm,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  undoBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  muted: { marginTop: 12, color: theme.colors.textMuted },
  err: { color: theme.colors.error, fontSize: 16, fontWeight: "600" },
  cancelEdit: { marginTop: theme.spacing.sm, paddingVertical: 12, alignItems: "center" },
  cancelEditTxt: { color: theme.colors.textSoft, fontWeight: "800", fontSize: 15 },
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
});
