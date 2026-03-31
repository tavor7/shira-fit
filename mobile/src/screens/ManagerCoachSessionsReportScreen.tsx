import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Pressable,
  Modal,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { router, type Href } from "expo-router";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { supabase } from "../lib/supabase";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { toISODateLocal, isValidISODateString, parseISODateLocal } from "../lib/isoDate";
import type { ManagerCoachSessionReportRow } from "../types/database";
import { DatePickerField } from "../components/DatePickerField";

function defaultEndISO() {
  return toISODateLocal(new Date());
}

function defaultStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toISODateLocal(d);
}

type Trainer = { user_id: string; full_name: string; username: string; role: string };

function showError(msg: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(msg);
  } else {
    Alert.alert("Error", msg);
  }
}

export default function ManagerCoachSessionsReportScreen() {
  const [start, setStart] = useState(defaultStartISO);
  const [end, setEnd] = useState(defaultEndISO);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [coachId, setCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trainersLoading, setTrainersLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ManagerCoachSessionReportRow[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const loadTrainers = useCallback(async () => {
    setTrainersLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, username, role")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setTrainers((data as Trainer[]) ?? []);
    setTrainersLoading(false);
  }, []);

  useEffect(() => {
    loadTrainers();
  }, [loadTrainers]);

  const loadReport = useCallback(async () => {
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e)) {
      showError("Please choose valid start and end dates.");
      return;
    }
    if (s > e) {
      showError("Start date must be on or before end date.");
      return;
    }
    if (!coachId) {
      showError("Choose a trainer (coach or manager).");
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.rpc("manager_coach_sessions_report", {
      p_start: s,
      p_end: e,
      p_coach_id: coachId,
    });
    setLoading(false);
    setHasSearched(true);
    if (error) {
      showError(error.message);
      setRows([]);
      return;
    }
    setRows((data as ManagerCoachSessionReportRow[]) ?? []);
  }, [start, end, coachId]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        <DatePickerField label="From" value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
        <DatePickerField label="To" value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
        <Text style={styles.label}>Trainer</Text>
        <Pressable style={styles.pickerTouch} onPress={() => setPickerOpen(true)}>
          <Text style={coachLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {coachLabel || "Choose coach or manager…"}
          </Text>
        </Pressable>
        <Text style={styles.hint}>
          Lists every session assigned to that trainer in the range. Registered = active sign-ups; arrived = marked as
          attended.
        </Text>
        <PrimaryButton label="Load report" onPress={loadReport} loading={loading} loadingLabel="Loading…" />
      </View>

      <Modal visible={pickerOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Trainers</Text>
              <Pressable onPress={() => setPickerOpen(false)}>
                <Text style={styles.modalClose}>Done</Text>
              </Pressable>
            </View>
            {trainersLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={trainers}
                keyExtractor={(item) => item.user_id}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                    onPress={() => {
                      setCoachId(item.user_id);
                      setCoachLabel(`${item.full_name} (@${item.username}) · ${item.role}`);
                      setPickerOpen(false);
                    }}
                  >
                    <Text style={styles.pickerItemName}>{item.full_name}</Text>
                    <Text style={styles.pickerItemRole}>
                      @{item.username} · {item.role}
                    </Text>
                  </Pressable>
                )}
                ListEmptyComponent={<Text style={styles.pickerEmpty}>No trainers</Text>}
              />
            )}
          </View>
        </View>
      </Modal>

      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(item) => item.session_id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.9 }]}
            onPress={() => router.push(`/(app)/manager/session/${item.session_id}` as Href)}
          >
            <Text style={styles.rowDate}>{item.session_date}</Text>
            <Text style={styles.rowTime}>{formatSessionTimeRange(item.start_time, item.duration_minutes ?? 60)}</Text>
            <Text style={styles.rowStats}>
              Registered: {item.registered_count} · Arrived: {item.arrived_count}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!hasSearched ? "Pick a trainer and date range, then tap Load report." : "No sessions in this range."}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  filters: {
    padding: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  hint: { marginTop: theme.spacing.sm, fontSize: 12, color: theme.colors.textMuted, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    backgroundColor: theme.colors.white,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerText: { fontSize: 16, color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, color: theme.colors.textSoftOnLight },
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: {
    backgroundColor: theme.colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: theme.spacing.md,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
  list: { flex: 1 },
  listContent: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, flexGrow: 1 },
  row: {
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowDate: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  rowTime: { marginTop: 4, fontSize: 14, color: theme.colors.cta, fontWeight: "600" },
  rowStats: { marginTop: 8, fontSize: 14, color: theme.colors.textMuted, fontWeight: "600" },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl, fontSize: 14 },
});
