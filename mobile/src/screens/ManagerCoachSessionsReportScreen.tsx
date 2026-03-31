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
import { useI18n } from "../context/I18nContext";

function defaultEndISO() {
  return toISODateLocal(new Date());
}

function defaultStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toISODateLocal(d);
}

type Trainer = { user_id: string; full_name: string; username: string; role: string; phone?: string | null };

export default function ManagerCoachSessionsReportScreen() {
  const { language, t, isRTL } = useI18n();
  const [start, setStart] = useState(defaultStartISO);
  const [end, setEnd] = useState(defaultEndISO);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [coachId, setCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [trainersLoading, setTrainersLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ManagerCoachSessionReportRow[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const loadTrainers = useCallback(async () => {
    setTrainersLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, username, role, phone")
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
      const msg = language === "he" ? "בחרו תאריכי התחלה וסיום תקינים." : "Please choose valid start and end dates.";
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
      else Alert.alert(t("common.error"), msg);
      return;
    }
    if (s > e) {
      const msg = language === "he" ? "תאריך ההתחלה חייב להיות לפני או שווה לתאריך הסיום." : "Start date must be on or before end date.";
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
      else Alert.alert(t("common.error"), msg);
      return;
    }
    if (!coachId) {
      const msg = language === "he" ? "בחרו מאמן/ת (מאמן או מנהל)." : "Choose a trainer (coach or manager).";
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
      else Alert.alert(t("common.error"), msg);
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
      const msg = error.message;
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
      else Alert.alert(t("common.error"), msg);
      setRows([]);
      return;
    }
    setRows((data as ManagerCoachSessionReportRow[]) ?? []);
  }, [start, end, coachId, language, t]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        <DatePickerField label={t("common.from")} value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
        <DatePickerField label={t("common.to")} value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
        <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "מאמן" : "Trainer"}</Text>
        <Pressable style={styles.pickerTouch} onPress={() => setPickerOpen(true)}>
          <Text style={coachLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {coachLabel || (language === "he" ? "בחרו מאמן או מנהל…" : "Choose coach or manager…")}
          </Text>
        </Pressable>
        <Text style={[styles.hint, isRTL && styles.rtlText]}>
          {language === "he"
            ? "מציג את כל האימונים של אותו מאמן בטווח. נרשמו = הרשמות פעילות; הגיעו = סומנו כנוכחים."
            : "Lists every session assigned to that trainer in the range. Registered = active sign-ups; arrived = marked as attended."}
        </Text>
        <PrimaryButton
          label={language === "he" ? "טעינת דוח" : "Load report"}
          onPress={loadReport}
          loading={loading}
          loadingLabel={t("common.loading")}
        />
      </View>

      <Modal visible={pickerOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{language === "he" ? "מאמנים" : "Trainers"}</Text>
              <Pressable onPress={() => setPickerOpen(false)}>
                <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
              </Pressable>
            </View>
            <View style={styles.modalSearchRow}>
              <TextInput
                value={pickerQ}
                onChangeText={setPickerQ}
                placeholder={language === "he" ? "חיפוש שם / משתמש / טלפון…" : "Search name / username / phone…"}
                placeholderTextColor={theme.colors.placeholderOnLight}
                style={styles.modalSearch}
                autoCapitalize="none"
              />
            </View>
            {trainersLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={trainers.filter((t) => {
                  const q = pickerQ.trim().toLowerCase();
                  if (!q) return true;
                  const phone = (t as unknown as { phone?: string | null }).phone ?? "";
                  return (
                    (t.full_name ?? "").toLowerCase().includes(q) ||
                    (t.username ?? "").toLowerCase().includes(q) ||
                    String(phone).toLowerCase().includes(q)
                  );
                })}
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
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && styles.rtlText]}>{language === "he" ? "אין מאמנים" : "No trainers"}</Text>
                }
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
              {language === "he" ? "נרשמו" : "Registered"}: {item.registered_count} · {language === "he" ? "הגיעו" : "Arrived"}:{" "}
              {item.arrived_count}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!hasSearched
              ? language === "he"
                ? "בחרו מאמן וטווח תאריכים, ואז לחצו על טעינת דוח."
                : "Pick a trainer and date range, then tap Load report."
              : language === "he"
                ? "אין אימונים בטווח הזה."
                : "No sessions in this range."}
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
  rtlText: { textAlign: "right" },
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
  modalSearchRow: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.sm },
  modalSearch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
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
