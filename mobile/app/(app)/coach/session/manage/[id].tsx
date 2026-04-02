import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ActivityIndicator, ScrollView } from "react-native";
import { supabase } from "../../../../../src/lib/supabase";
import type { TrainingSession } from "../../../../../src/types/database";
import { theme } from "../../../../../src/theme";
import { PrimaryButton } from "../../../../../src/components/PrimaryButton";
import { DatePickerField } from "../../../../../src/components/DatePickerField";
import { isMissingColumnError } from "../../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../../src/lib/isoDate";
import { useI18n } from "../../../../../src/context/I18nContext";

export default function CoachSessionManageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

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

  if (forbidden) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.err, isRTL && styles.rtlText]}>
          {language === "he"
            ? "אפשר לערוך רק אימונים שבהם אתה/את המאמן/ת."
            : "You can only edit sessions where you are the trainer."}
        </Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.err, isRTL && styles.rtlText]}>{language === "he" ? "האימון לא נמצא." : "Session not found."}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "עריכת האימון שלך" : "Edit your session"}</Text>
      <DatePickerField label={language === "he" ? "תאריך אימון" : "Session date"} value={date} onChange={setDate} />
      <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "שעת התחלה (HH:MM)" : "Start time (HH:MM)"}</Text>
      <TextInput style={styles.input} value={time} onChangeText={setTime} placeholderTextColor={theme.colors.placeholderOnLight} />
      <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "מקסימום משתתפים" : "Max participants"}</Text>
      <TextInput style={styles.input} value={maxP} onChangeText={setMaxP} keyboardType="number-pad" placeholderTextColor={theme.colors.placeholderOnLight} />
      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "משך (דקות)" : "Length (minutes)"}</Text>
      <TextInput style={styles.input} value={durationMin} onChangeText={setDurationMin} keyboardType="number-pad" placeholderTextColor={theme.colors.placeholderOnLight} />
      <Pressable
        style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }, isRTL && styles.toggleRtl]}
        onPress={() => setOpen(!open)}
      >
        <Text style={[styles.toggleText, isRTL && styles.toggleTextRtl]}>
          {language === "he" ? "פתוח להרשמה: " : "Open for registration: "}
          {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
        </Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }, isRTL && styles.toggleRtl]}
        onPress={() => setHidden(!hidden)}
      >
        <Text style={[styles.toggleText, isRTL && styles.toggleTextRtl]}>
          {language === "he"
            ? "מוסתר (צוות בלבד ביומן, ללא הרשמה עצמית): "
            : "Hidden (staff calendar only, no athlete self-register): "}
          {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
        </Text>
      </Pressable>
      <PrimaryButton label={t("common.save")} onPress={saveSession} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  rtlText: { textAlign: "right" },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    padding: 10,
    marginTop: 6,
    marginBottom: 8,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  toggle: { padding: 12, backgroundColor: theme.colors.white, borderRadius: theme.radius.sm, marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  toggleText: { color: theme.colors.textOnLight, fontSize: 16 },
  toggleRtl: { alignItems: "flex-end" },
  toggleTextRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch", width: "100%" },
  muted: { marginTop: 12, color: theme.colors.textMuted },
  err: { color: theme.colors.error, fontSize: 16, fontWeight: "600" },
});
