import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { supabase } from "../lib/supabase";
import { AppSearchSheet } from "../components/AppSearchSheet";
import { CollapsibleDateRangeCard } from "../components/CollapsibleDateRangeCard";
import { EmptyState } from "../components/EmptyState";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { formatISODateFull } from "../lib/dateFormat";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { athletePickerLabel, athleteSearchSubtitle } from "../lib/displayName";
import { globalOverviewRangeISO } from "../lib/managerPeriodMode";
import { parseMoney } from "../lib/participantHistoryHelpers";
import type { SuperUserHiddenRecord } from "../types/database";

type AthletePickerRow = { user_id: string; full_name: string; phone: string };

export default function SuperUserHiddenWorkoutsScreen() {
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();

  const [athleteId, setAthleteId] = useState("");
  const [athleteLabel, setAthleteLabel] = useState("");
  const defaultRange = globalOverviewRangeISO();
  const [start, setStart] = useState(defaultRange.start);
  const [end, setEnd] = useState(defaultRange.end);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [athletes, setAthletes] = useState<AthletePickerRow[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);
  const [rows, setRows] = useState<SuperUserHiddenRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const totals = useMemo(() => {
    const totalIls = rows.reduce((sum, r) => sum + (parseMoney(r.expected_ils) ?? 0), 0);
    return { count: rows.length, totalIls: Math.round(totalIls * 100) / 100 };
  }, [rows]);

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("super_user_list_hidden_records", {
      p_athlete_id: athleteId || null,
      p_start: start || null,
      p_end: end || null,
      p_include_unhidden: false,
    });
    setLoading(false);
    if (error) {
      showError(error.message);
      return;
    }
    setRows((data as SuperUserHiddenRecord[]) ?? []);
  }, [athleteId, start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAthletes = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data } = await query;
    setAthletesLoading(false);
    setAthletes((data as AthletePickerRow[]) ?? []);
  }, []);

  function confirmUnhide(row: SuperUserHiddenRecord) {
    showConfirm({
      title: t("superUser.unhideConfirmTitle"),
      message: t("superUser.unhideConfirmMessage").replace("{name}", row.athlete_name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("superUser.unhide"),
      onConfirm: () => void unhide(row),
    });
  }

  async function unhide(row: SuperUserHiddenRecord) {
    setBusyId(row.hide_id);
    const { data, error } = await supabase.rpc("super_user_unhide_registration", {
      p_session_id: row.session_id,
      p_user_id: row.athlete_user_id,
    });
    setBusyId(null);
    if (error) {
      showError(error.message);
      return;
    }
    if (data?.ok !== true) {
      showError(String(data?.error ?? "failed"));
      return;
    }
    showToast({ message: t("superUser.unhidden"), variant: "success" });
    await load();
  }

  return (
    <View style={styles.screen}>
      <AppSearchSheet
        visible={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerQ("");
        }}
        title={language === "he" ? "מתאמנים" : "Athletes"}
        dismissLabel={t("common.ok")}
        isRTL={isRTL}
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        searchConfig={{
          value: pickerQ,
          onChangeText: setPickerQ,
          onSearch: (term) => void loadAthletes(term),
          placeholder: language === "he" ? "חיפוש שם / משתמש / טלפון…" : "Search name / username / phone…",
          loading: athletesLoading,
        }}
        data={athletes}
        keyExtractor={(item) => item.user_id}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
            onPress={() => {
              setAthleteId(item.user_id);
              setAthleteLabel(athletePickerLabel(item.full_name, item.phone));
              setPickerOpen(false);
            }}
          >
            <Text style={styles.pickerItemName}>{item.full_name}</Text>
            <Text style={styles.pickerItemSub}>{athleteSearchSubtitle(item.phone)}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<EmptyState icon="🔍" title={t("participantHistory.noAthletes")} isRTL={isRTL} />}
      />

      <View style={styles.filters}>
        <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("superUser.hiddenHint")}</Text>
        <Pressable style={styles.pickerTouch} onPress={() => { setPickerQ(""); setPickerOpen(true); }}>
          <Text style={athleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {athleteLabel || t("superUser.filterAthletePlaceholder")}
          </Text>
        </Pressable>
        <CollapsibleDateRangeCard
          start={start}
          end={end}
          onChange={({ start: s, end: e }) => {
            setStart(s);
            setEnd(e);
          }}
          label={t("superUser.dateRange")}
        />
        {athleteId || start !== defaultRange.start || end !== defaultRange.end ? (
          <Pressable
            style={({ pressed }) => [styles.clearSel, pressed && { opacity: 0.9 }]}
            onPress={() => {
              setAthleteId("");
              setAthleteLabel("");
              const fresh = globalOverviewRangeISO();
              setStart(fresh.start);
              setEnd(fresh.end);
            }}
          >
            <Text style={styles.clearSelTxt}>{t("superUser.clearFilters")}</Text>
          </Pressable>
        ) : null}
      </View>

      {!loading ? (
        <View style={styles.totalsBar}>
          <View style={styles.totalsCell}>
            <Text style={styles.totalsLabel}>{t("superUser.totalWorkouts")}</Text>
            <Text style={styles.totalsValue}>{totals.count}</Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.totalsLabel}>{t("superUser.totalMoney")}</Text>
            <Text style={styles.totalsValue}>{`${totals.totalIls} ₪`}</Text>
          </View>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loadingStack}>
          <ListRowSkeleton />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.hide_id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => (
            <FadeSlideIn delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={styles.card}>
                <View style={[styles.cardHead, isRTL && styles.cardHeadRtl]}>
                  <Text style={[styles.athleteName, isRTL && styles.rtlText]} numberOfLines={1}>
                    {item.athlete_name}
                  </Text>
                  <View style={styles.badge}>
                    <Text style={styles.badgeTxt}>{t("superUser.hiddenBadge")}</Text>
                  </View>
                </View>
                <Text style={[styles.meta, isRTL && styles.rtlText]}>
                  {formatISODateFull(item.session_date, language)} ·{" "}
                  {formatSessionTimeRange(item.start_time, item.duration_minutes)}
                </Text>
                {item.coach_name ? (
                  <Text style={[styles.meta, isRTL && styles.rtlText]}>{item.coach_name}</Text>
                ) : null}
                <Text style={[styles.expected, isRTL && styles.rtlText]}>
                  {t("superUser.expectedAmount")}: {parseMoney(item.expected_ils) ?? 0} ₪
                </Text>
                <Text style={[styles.metaMuted, isRTL && styles.rtlText]}>
                  {t("superUser.hiddenAt")}: {formatISODateFull(item.hidden_at.slice(0, 10), language)}
                  {item.hidden_by_name ? ` · ${t("superUser.hiddenBy")}: ${item.hidden_by_name}` : ""}
                </Text>
                <Pressable
                  disabled={busyId === item.hide_id}
                  style={({ pressed }) => [
                    styles.unhideBtn,
                    pressed && { opacity: 0.9 },
                    busyId === item.hide_id && { opacity: 0.6 },
                  ]}
                  onPress={() => confirmUnhide(item)}
                >
                  <Text style={styles.unhideBtnTxt}>{t("superUser.unhide")}</Text>
                </Pressable>
              </View>
            </FadeSlideIn>
          )}
          ListEmptyComponent={<EmptyState icon="👁️" title={t("superUser.noRecords")} isRTL={isRTL} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  rtlText: { textAlign: "right" },
  filters: { padding: theme.spacing.md, gap: theme.spacing.sm },
  hint: { color: theme.colors.textMuted, lineHeight: 18, fontSize: 12 },
  pickerTouch: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  pickerText: { color: theme.colors.text, fontWeight: "700" },
  pickerPlaceholder: { color: theme.colors.textMuted },
  pickerItem: { paddingVertical: 10, paddingHorizontal: 4 },
  pickerItemName: { color: theme.colors.text, fontWeight: "800", fontSize: 15 },
  pickerItemSub: { color: theme.colors.textMuted, marginTop: 2 },
  clearSel: { alignSelf: "flex-start" },
  clearSelTxt: { color: theme.colors.cta, fontWeight: "800", fontSize: 13 },
  totalsBar: {
    flexDirection: "row",
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  totalsCell: { flex: 1, paddingVertical: 12, alignItems: "center" },
  totalsLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  totalsValue: { marginTop: 3, fontSize: 18, fontWeight: "900", color: theme.colors.text },
  loadingStack: { padding: theme.spacing.md, gap: theme.spacing.sm },
  listContent: { padding: theme.spacing.md, paddingTop: 0, gap: theme.spacing.sm, paddingBottom: theme.spacing.xl },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 4,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm },
  cardHeadRtl: { flexDirection: "row-reverse" },
  athleteName: { color: theme.colors.text, fontWeight: "900", fontSize: 16, flex: 1 },
  badge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.errorBg,
  },
  badgeTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 11 },
  meta: { color: theme.colors.textSoft, fontSize: 13 },
  expected: { color: theme.colors.text, fontSize: 13, fontWeight: "800", marginTop: 2 },
  metaMuted: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  unhideBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  unhideBtnTxt: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 13 },
});
