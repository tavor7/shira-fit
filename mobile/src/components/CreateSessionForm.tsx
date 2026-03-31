import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Modal, FlatList, ActivityIndicator } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "./PrimaryButton";
import { addDaysToISODate } from "../lib/sessionTime";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { toISODateLocal, isValidISODateString } from "../lib/isoDate";
import { DatePickerField } from "./DatePickerField";

type CoachOption = { user_id: string; full_name: string; role: string; username: string };

type Props = {
  initialDate?: string;
  /** When set, trainer is fixed (coach creating their own session). */
  fixedCoachId?: string;
  fixedCoachLabel?: string;
};

export function CreateSessionForm({ initialDate, fixedCoachId, fixedCoachLabel }: Props) {
  const [date, setDate] = useState(() => initialDate?.trim() || toISODateLocal(new Date()));
  const [time, setTime] = useState("18:00");
  const [coachId, setCoachId] = useState(fixedCoachId ?? "");
  const [coachLabel, setCoachLabel] = useState(fixedCoachLabel ? `${fixedCoachLabel} — you` : "");
  const [coachOptions, setCoachOptions] = useState<CoachOption[]>([]);
  const [coachOptionsLoading, setCoachOptionsLoading] = useState(!fixedCoachId);
  const [showCoachPicker, setShowCoachPicker] = useState(false);
  const [max, setMax] = useState("12");
  const [durationMinutes, setDurationMinutes] = useState("55");
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [weeklyOccurrences, setWeeklyOccurrences] = useState("4");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialDate?.trim()) setDate(initialDate.trim());
  }, [initialDate]);

  useEffect(() => {
    if (fixedCoachId) {
      setCoachId(fixedCoachId);
      setCoachLabel(fixedCoachLabel ? `${fixedCoachLabel} — you` : "You");
      setCoachOptionsLoading(false);
    }
  }, [fixedCoachId, fixedCoachLabel]);

  const loadCoaches = useCallback(async () => {
    if (fixedCoachId) return;
    setCoachOptionsLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, username")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setCoachOptions((data as CoachOption[]) ?? []);
    setCoachOptionsLoading(false);
  }, [fixedCoachId]);

  useFocusEffect(useCallback(() => { loadCoaches(); }, [loadCoaches]));

  function selectCoach(opt: CoachOption) {
    setCoachId(opt.user_id);
    setCoachLabel(`${opt.full_name} — ${opt.role}`);
    setShowCoachPicker(false);
  }

  async function save() {
    setError(null);
    const trimmedDate = date.trim();
    if (!isValidISODateString(trimmedDate)) {
      setError("Please choose a valid session date.");
      return;
    }
    if (!coachId) {
      setError(fixedCoachId ? "Could not resolve your account." : "Please choose a coach or manager.");
      return;
    }
    const parsedDuration = parseInt(durationMinutes.trim(), 10);
    const duration = Number.isFinite(parsedDuration) ? parsedDuration : 55;
    if (duration < 1 || duration > 24 * 60) {
      setError("Session length must be between 1 and 1440 minutes (24 hours).");
      return;
    }
    const startT = time.trim() || "18:00";
    const maxP = parseInt(max, 10) || 1;
    let count = 1;
    if (repeatWeekly) {
      const n = parseInt(weeklyOccurrences.trim(), 10);
      count = Number.isFinite(n) ? n : 4;
      if (count < 1) count = 1;
      if (count > 52) count = 52;
    }
    const rows = Array.from({ length: count }, (_, i) => ({
      session_date: addDaysToISODate(trimmedDate, i * 7),
      start_time: startT,
      coach_id: coachId,
      max_participants: maxP,
      is_open_for_registration: open,
      is_hidden: hidden,
      duration_minutes: duration,
    }));
    setSaving(true);
    let err = (await supabase.from("training_sessions").insert(rows)).error;
    let usedLegacyInsert = false;
    if (err && isMissingColumnError(err.message, "is_hidden")) {
      const rowsLegacy = rows.map(({ is_hidden: _h, ...rest }) => rest);
      const retry = await supabase.from("training_sessions").insert(rowsLegacy);
      err = retry.error;
      if (!err) usedLegacyInsert = true;
    }
    setSaving(false);
    if (err) {
      setError(err.message);
      Alert.alert("Error", err.message);
      return;
    }
    if (usedLegacyInsert && hidden) {
      Alert.alert(
        "Saved (visible sessions)",
        "Your project is missing the `is_hidden` column (migration not applied). Sessions were created as normal. In Supabase → SQL Editor, run `supabase/migrations/20250330180000_session_hidden.sql`. If the column exists but you still see this, open Project Settings → API → Reload schema."
      );
    }
    if (count > 1 && !(usedLegacyInsert && hidden)) {
      Alert.alert("Saved", `Created ${count} weekly sessions.`);
    }
    router.back();
  }

  return (
    <ScrollView contentContainerStyle={styles.box} keyboardShouldPersistTaps="handled">
      <DatePickerField label="Session date" value={date} onChange={setDate} />
      <Text style={styles.label}>Start time (HH:MM)</Text>
      <TextInput
        style={styles.input}
        value={time}
        onChangeText={setTime}
        placeholderTextColor={theme.colors.placeholderOnLight}
      />
      {fixedCoachId ? (
        <>
          <Text style={styles.label}>Trainer</Text>
          <View style={styles.fixedCoachBox}>
            <Text style={styles.fixedCoachTxt}>{coachLabel || "You"}</Text>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.label}>Trainer (coach or manager)</Text>
          <Pressable style={styles.pickerTouch} onPress={() => setShowCoachPicker(true)}>
            <Text style={coachLabel ? styles.pickerText : styles.pickerPlaceholder}>{coachLabel || "Choose trainer by name…"}</Text>
          </Pressable>
          <Modal visible={showCoachPicker} transparent animationType="slide">
            <View style={styles.modalBackdrop}>
              <Pressable style={styles.modalBackdropTouch} onPress={() => setShowCoachPicker(false)} />
              <View style={styles.modalBox}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>All trainers</Text>
                  <Pressable onPress={() => setShowCoachPicker(false)}><Text style={styles.modalClose}>Done</Text></Pressable>
                </View>
                {coachOptionsLoading ? (
                  <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
                ) : (
                  <FlatList
                    data={coachOptions}
                    keyExtractor={(item) => item.user_id}
                    renderItem={({ item }) => (
                      <Pressable style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.8 }]} onPress={() => selectCoach(item)}>
                        <View style={styles.pickerItemTextCol}>
                          <Text style={styles.pickerItemName}>{item.full_name}</Text>
                          <Text style={styles.pickerItemRole}>
                            @{item.username} · {item.role}
                          </Text>
                        </View>
                      </Pressable>
                    )}
                    ListEmptyComponent={<Text style={styles.pickerEmpty}>No coaches or managers yet</Text>}
                  />
                )}
              </View>
            </View>
          </Modal>
        </>
      )}
      <Text style={styles.label}>Session length (minutes)</Text>
      <TextInput
        style={styles.input}
        value={durationMinutes}
        onChangeText={setDurationMinutes}
        keyboardType="number-pad"
        placeholder="55 (default)"
        placeholderTextColor={theme.colors.placeholderOnLight}
      />
      <Text style={styles.label}>Max participants</Text>
      <TextInput
        style={styles.input}
        value={max}
        onChangeText={setMax}
        keyboardType="number-pad"
        placeholderTextColor={theme.colors.placeholderOnLight}
      />
      <Pressable style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }]} onPress={() => setRepeatWeekly(!repeatWeekly)}>
        <Text style={styles.toggleText}>Repeat weekly (same weekday): {repeatWeekly ? "Yes" : "No"}</Text>
      </Pressable>
      {repeatWeekly ? (
        <>
          <Text style={styles.label}>Number of sessions (one per week)</Text>
          <TextInput
            style={styles.input}
            value={weeklyOccurrences}
            onChangeText={setWeeklyOccurrences}
            keyboardType="number-pad"
            placeholder="4"
            placeholderTextColor={theme.colors.placeholderOnLight}
          />
        </>
      ) : null}
      <Pressable style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }]} onPress={() => setOpen(!open)}>
        <Text style={styles.toggleText}>Open for registration: {open ? "Yes" : "No"} (Thu job sets week)</Text>
      </Pressable>
      <Pressable style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.9 }]} onPress={() => setHidden(!hidden)}>
        <Text style={styles.toggleText}>
          Hidden session: {hidden ? "Yes" : "No"} (only coaches/managers see it on the calendar; athletes can’t self-register)
        </Text>
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <PrimaryButton label="Save session" onPress={save} loading={saving} loadingLabel="Saving…" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { flexGrow: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    padding: 12,
    marginTop: 4,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  fixedCoachBox: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    padding: 12,
    marginTop: 4,
    backgroundColor: theme.colors.white,
    minHeight: 48,
    justifyContent: "center",
  },
  fixedCoachTxt: { fontSize: 16, color: theme.colors.textOnLight, fontWeight: "600" },
  toggle: { marginTop: theme.spacing.md, padding: theme.spacing.sm, backgroundColor: theme.colors.white, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.colors.border },
  toggleText: { color: theme.colors.textOnLight, fontSize: 16 },
  errorText: { marginTop: theme.spacing.sm, color: theme.colors.error, fontSize: 14 },
  pickerTouch: { borderWidth: 1, borderColor: theme.colors.borderInput, borderRadius: theme.radius.sm, padding: 12, marginTop: 4, backgroundColor: theme.colors.white, minHeight: 48, justifyContent: "center" },
  pickerText: { fontSize: 16, color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, color: theme.colors.textSoftOnLight },
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: { backgroundColor: theme.colors.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "70%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemTextCol: { flex: 1 },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4, textTransform: "none" },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
});
