import { useCallback, useMemo, useState } from "react";
import { View, Text, SectionList, TextInput, StyleSheet, Platform, Alert, Pressable, Modal, FlatList, ActivityIndicator } from "react-native";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { DatePickerField } from "../components/DatePickerField";
import { supabase } from "../lib/supabase";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { toISODateLocal, isValidISODateString, parseISODateLocal } from "../lib/isoDate";
import type { ParticipantHistoryRow } from "../types/database";
import { useI18n } from "../context/I18nContext";

function defaultEndISO() {
  return toISODateLocal(new Date());
}

function defaultStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toISODateLocal(d);
}

type Section = { title: string; data: ParticipantHistoryRow[] };
type Athlete = { user_id: string; full_name: string; username: string; phone: string };

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

export default function ParticipantHistoryScreen() {
  const { language, t, isRTL } = useI18n();
  const [start, setStart] = useState(defaultStartISO);
  const [end, setEnd] = useState(defaultEndISO);
  const [athleteId, setAthleteId] = useState<string>("");
  const [athleteLabel, setAthleteLabel] = useState<string>("");
  const [phone, setPhone] = useState(""); // used as RPC filter; set from athlete selection
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rows, setRows] = useState<ParticipantHistoryRow[]>([]);
  const [emptyHint, setEmptyHint] = useState<string>(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");

  function showError(msg: string) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(msg);
    } else {
      Alert.alert(t("common.error"), msg);
    }
  }

  const sections = useMemo(() => groupByAthlete(rows), [rows]);

  const loadAthletes = useCallback(async () => {
    const q = pickerQ.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;
    setAthletesLoading(false);
    if (error) {
      setAthletes([]);
      return;
    }
    setAthletes((data as Athlete[]) ?? []);
  }, [pickerQ]);

  const load = useCallback(async () => {
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e)) {
      showError(language === "he" ? "בחרו תאריכי התחלה וסיום תקינים." : "Please choose valid start and end dates.");
      return;
    }
    if (s > e) {
      showError(language === "he" ? "תאריך ההתחלה חייב להיות לפני או שווה לתאריך הסיום." : "Start date must be on or before end date.");
      return;
    }
    if (!athleteId) {
      showError(language === "he" ? "בחרו מתאמן קודם." : "Choose an athlete first.");
      return;
    }
    setLoading(true);
    const phoneArg = phone.trim().length > 0 ? phone.trim() : null;
    const { data, error } = await supabase.rpc("participant_registration_history", {
      p_start: s,
      p_end: e,
      p_phone_search: phoneArg,
    });
    if (error) {
      setLoading(false);
      showError(error.message);
      setRows([]);
      setHasSearched(true);
      return;
    }
    const next = (data as ParticipantHistoryRow[]) ?? [];
    setRows(next);

    if (next.length === 0) setEmptyHint(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");

    setLoading(false);
    setHasSearched(true);
  }, [start, end, phone, athleteId, language]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        <DatePickerField label={t("common.from")} value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
        <DatePickerField label={t("common.to")} value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
        <Text style={[styles.label, isRTL && styles.rtlText]}>
          {language === "he" ? "מתאמן (חיפוש לפי שם, משתמש או טלפון)" : "Athlete (search by name, username, or phone)"}
        </Text>
        <Pressable style={styles.pickerTouch} onPress={() => { setPickerOpen(true); loadAthletes(); }}>
          <Text style={athleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {athleteLabel || (language === "he" ? "בחרו מתאמן…" : "Choose an athlete…")}
          </Text>
        </Pressable>
        {athleteId ? (
          <Pressable
            style={({ pressed }) => [styles.clearSel, pressed && { opacity: 0.9 }]}
            onPress={() => {
              setAthleteId("");
              setAthleteLabel("");
              setPhone("");
            }}
          >
            <Text style={styles.clearSelTxt}>{t("common.clearSelection")}</Text>
          </Pressable>
        ) : null}
        <Text style={[styles.hint, isRTL && styles.rtlText]}>
          {language === "he"
            ? "בחרו מתאמן ואז טענו רישומים בטווח התאריכים."
            : "Pick an athlete first, then load registrations in the date range."}
        </Text>
        <PrimaryButton label={t("common.load")} onPress={load} loading={loading} loadingLabel={t("common.loading")} />
      </View>

      <Modal visible={pickerOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{language === "he" ? "מתאמנים" : "Athletes"}</Text>
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
                onSubmitEditing={loadAthletes}
              />
              <Pressable style={({ pressed }) => [styles.modalSearchBtn, pressed && { opacity: 0.9 }]} onPress={loadAthletes}>
                <Text style={styles.modalSearchBtnTxt}>{t("common.search")}</Text>
              </Pressable>
            </View>
            {athletesLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={athletes}
                keyExtractor={(item) => item.user_id}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                    onPress={() => {
                      setAthleteId(item.user_id);
                      setAthleteLabel(`${item.full_name} (@${item.username}) · ${item.phone}`);
                      setPhone(item.phone);
                      setPickerOpen(false);
                    }}
                  >
                    <Text style={styles.pickerItemName}>{item.full_name}</Text>
                    <Text style={styles.pickerItemRole}>
                      @{item.username} · {item.phone}
                    </Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && styles.rtlText]}>{language === "he" ? "אין מתאמנים" : "No athletes"}</Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>

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
            att === true
              ? language === "he"
                ? "הגיע"
                : "Arrived"
              : att === false
                ? language === "he"
                  ? "נעדר"
                  : "Absent"
                : language === "he"
                  ? "נוכחות לא סומנה"
                  : "Attendance not set";
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
                  {item.reg_status === "active"
                    ? language === "he"
                      ? "פעיל"
                      : "Active"
                    : language === "he"
                      ? "בוטל"
                      : "Cancelled"}
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
            {!hasSearched
              ? language === "he"
                ? "בחרו טווח תאריכים ומתאמן, ואז לחצו על טען."
                : "Set the period (and optional phone), then tap Load."
              : emptyHint}
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
  rtlText: { textAlign: "right" },
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
  clearSel: { marginTop: 8, alignSelf: "flex-start" },
  clearSelTxt: { color: theme.colors.textMuted, fontWeight: "700" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: { backgroundColor: theme.colors.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalSearchRow: { flexDirection: "row", gap: 10, padding: theme.spacing.md, paddingTop: theme.spacing.sm },
  modalSearch: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  modalSearchBtn: { paddingHorizontal: 14, borderRadius: theme.radius.md, backgroundColor: theme.colors.cta, alignItems: "center", justifyContent: "center" },
  modalSearchBtnTxt: { color: theme.colors.ctaText, fontWeight: "800" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
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
