import { useLocalSearchParams, router } from "expo-router";
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
import { ActionButton } from "../../../../src/components/ActionButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { DatePickerField } from "../../../../src/components/DatePickerField";
import { isMissingColumnError } from "../../../../src/lib/dbColumnErrors";
import { isValidISODateString } from "../../../../src/lib/isoDate";

export default function ManagerSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [participantsRev, setParticipantsRev] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

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
  }

  useEffect(() => {
    load();
  }, [id]);

  async function saveSession() {
    if (!isValidISODateString(date.trim())) {
      Alert.alert("Invalid date", "Please choose a valid session date.");
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
      Alert.alert("Error", error.message);
      return;
    }
    router.replace("/(app)/manager/sessions");
    if (savedWithoutHidden) {
      Alert.alert("Note", "Hidden-session column is not on the database yet; other fields were saved.");
    }
  }

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("manager_remove_athlete", {
      p_session_id: id,
      p_user_id: userId,
    });
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) {
      load();
      setParticipantsRev((n) => n + 1);
    } else Alert.alert("Failed", data?.error ?? "");
  }

  if (!session) return <Text style={styles.loading}>Loading…</Text>;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h}>Edit session</Text>
      <DatePickerField label="Session date" value={date} onChange={setDate} />
      <Text style={styles.label}>Start time (HH:MM)</Text>
      <TextInput style={styles.input} value={time} onChangeText={setTime} placeholderTextColor={theme.colors.placeholderOnLight} />
      <Text style={styles.label}>Max participants</Text>
      <TextInput style={styles.input} value={maxP} onChangeText={setMaxP} keyboardType="number-pad" placeholderTextColor={theme.colors.placeholderOnLight} />
      <Text style={styles.h}>Length (minutes)</Text>
      <TextInput style={styles.input} value={durationMin} onChangeText={setDurationMin} keyboardType="number-pad" placeholderTextColor={theme.colors.placeholderOnLight} />
      <Pressable style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }]} onPress={() => setOpen(!open)}>
        <Text style={styles.toggleText}>Open: {open ? "Yes" : "No"}</Text>
      </Pressable>
      <Pressable style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }]} onPress={() => setHidden(!hidden)}>
        <Text style={styles.toggleText}>Hidden (staff only on calendar): {hidden ? "Yes" : "No"}</Text>
      </Pressable>
      <PrimaryButton label="Save" onPress={saveSession} />

      <Text style={styles.h}>Participants & attendance</Text>
      <Text style={styles.sub}>Mark arrivals for active registrations. Past sessions keep this record for history.</Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={load}
        onRemoveAthlete={removeAthlete}
      />

      <View style={styles.link}>
        <ActionButton label="Coach view (waitlist / add)" onPress={() => router.push(`/(app)/coach/session/${id}`)} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  loading: { padding: theme.spacing.lg, color: theme.colors.textMuted },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  sub: { fontSize: 13, color: theme.colors.textMuted, marginBottom: theme.spacing.sm, lineHeight: 18 },
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
  link: { marginTop: theme.spacing.lg },
});
