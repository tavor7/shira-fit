import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ScrollView,
} from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import type { TrainingSession } from "../../../../src/types/database";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { DatePickerField } from "../../../../src/components/DatePickerField";
import { isMissingColumnError } from "../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../src/lib/isoDate";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay, formatISODateFull } from "../../../../src/lib/dateFormat";

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
  const [participantsRev, setParticipantsRev] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [editingSession, setEditingSession] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

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
      setMaxP(String(s.max_participants));
      setDurationMin(String(s.duration_minutes ?? 60));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
    }
    loadCancellations();
  }

  useEffect(() => {
    load();
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
          <PrimaryButton
            label={language === "he" ? "עריכת אימון" : "Edit session"}
            onPress={() => setEditingSession(true)}
            variant="ghost"
          />
        </View>
      ) : (
        <View style={styles.editBlock}>
          <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "עריכת אימון" : "Edit session"}</Text>
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
              {language === "he" ? "פתוח: " : "Open: "}
              {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }, isRTL && styles.toggleRtl]}
            onPress={() => setHidden(!hidden)}
          >
            <Text style={[styles.toggleText, isRTL && styles.toggleTextRtl]}>
              {language === "he" ? "מוסתר: " : "Hidden: "}
              {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
            </Text>
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
