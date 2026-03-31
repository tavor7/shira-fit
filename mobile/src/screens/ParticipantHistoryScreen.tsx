import { useCallback, useMemo, useState } from "react";
import { View, Text, SectionList, TextInput, StyleSheet, Platform, Alert } from "react-native";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { DatePickerField } from "../components/DatePickerField";
import { supabase } from "../lib/supabase";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { toISODateLocal, isValidISODateString, parseISODateLocal } from "../lib/isoDate";
import type { ParticipantHistoryRow } from "../types/database";

function defaultEndISO() {
  return toISODateLocal(new Date());
}

function defaultStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toISODateLocal(d);
}

type Section = { title: string; data: ParticipantHistoryRow[] };

function groupByAthlete(rows: ParticipantHistoryRow[]): Section[] {
  const map = new Map<string, ParticipantHistoryRow[]>();
  for (const r of rows) {
    const list = map.get(r.athlete_user_id) ?? [];
    list.push(r);
    map.set(r.athlete_user_id, list);
  }
  return Array.from(map.entries())
    .map(([uid, data]) => {
      const first = data[0];
      return {
        title: `${first?.athlete_name ?? uid} · ${first?.athlete_phone ?? ""}`,
        data,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function showError(msg: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(msg);
  } else {
    Alert.alert("Error", msg);
  }
}

export default function ParticipantHistoryScreen() {
  const [start, setStart] = useState(defaultStartISO);
  const [end, setEnd] = useState(defaultEndISO);
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rows, setRows] = useState<ParticipantHistoryRow[]>([]);

  const sections = useMemo(() => groupByAthlete(rows), [rows]);

  const load = useCallback(async () => {
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
    setLoading(true);
    const phoneArg = phone.trim().length > 0 ? phone.trim() : null;
    const { data, error } = await supabase.rpc("participant_registration_history", {
      p_start: s,
      p_end: e,
      p_phone_search: phoneArg,
    });
    setLoading(false);
    if (error) {
      showError(error.message);
      setRows([]);
      setHasSearched(true);
      return;
    }
    setRows((data as ParticipantHistoryRow[]) ?? []);
    setHasSearched(true);
  }, [start, end, phone]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        <DatePickerField label="From" value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
        <DatePickerField label="To" value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
        <Text style={styles.label}>Phone contains (optional)</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="e.g. 054"
          placeholderTextColor={theme.colors.placeholderOnLight}
          keyboardType="phone-pad"
        />
        <Text style={styles.hint}>Shows athletes registered for sessions in this range. Phone filters the list.</Text>
        <PrimaryButton label="Load" onPress={load} loading={loading} loadingLabel="Loading…" />
      </View>

      <SectionList
        style={styles.list}
        sections={sections}
        keyExtractor={(item) => item.registration_id}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{title}</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const att = item.attended;
          const attLabel =
            att === true ? "Arrived" : att === false ? "Absent" : "Attendance not set";
          const attStyle =
            att === true ? styles.badgeAttYes : att === false ? styles.badgeAttNo : styles.badgeAttUnset;
          const attTxtStyle =
            att === true ? styles.badgeAttTxtYes : att === false ? styles.badgeAttTxtNo : styles.badgeAttTxtUnset;
          return (
            <View style={styles.row}>
              <Text style={styles.rowDate}>{item.session_date}</Text>
              <Text style={styles.rowTime}>{formatSessionTimeRange(item.start_time, item.duration_minutes ?? 60)}</Text>
              <View style={[styles.badge, item.reg_status === "active" ? styles.badgeOn : styles.badgeOff]}>
                <Text style={[styles.badgeTxt, item.reg_status === "active" ? styles.badgeTxtOn : styles.badgeTxtOff]}>
                  {item.reg_status === "active" ? "Active" : "Cancelled"}
                </Text>
              </View>
              {item.reg_status === "active" ? (
                <View style={[styles.badge, attStyle, styles.badgeAtt]}>
                  <Text style={[styles.badgeTxt, attTxtStyle]}>{attLabel}</Text>
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!hasSearched ? "Set the period (and optional phone), then tap Load." : "No registrations match this filter."}
          </Text>
        }
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
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
  list: { flex: 1 },
  listContent: { paddingBottom: theme.spacing.xl, flexGrow: 1 },
  sectionHead: {
    backgroundColor: theme.colors.backgroundAlt,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  row: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowDate: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  rowTime: { marginTop: 4, fontSize: 14, color: theme.colors.cta, fontWeight: "600" },
  badge: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
  },
  badgeOn: { backgroundColor: theme.colors.successBg },
  badgeOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeTxt: { fontSize: 11, fontWeight: "800" },
  badgeTxtOn: { color: theme.colors.success },
  badgeTxtOff: { color: theme.colors.textMuted },
  badgeAtt: { marginTop: 6 },
  badgeAttYes: { backgroundColor: theme.colors.successBg, borderWidth: 0 },
  badgeAttTxtYes: { color: theme.colors.success },
  badgeAttNo: { backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  badgeAttTxtNo: { color: theme.colors.error },
  badgeAttUnset: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeAttTxtUnset: { color: theme.colors.textMuted },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl, fontSize: 14 },
});
