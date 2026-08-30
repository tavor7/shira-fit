import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { supabase } from "../lib/supabase";
import { AppSearchSheet } from "../components/AppSearchSheet";
import { AppSwitch } from "../components/AppSwitch";
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
  const [unhideAllOn, setUnhideAllOn] = useState(false);
  const [unhideAllBusy, setUnhideAllBusy] = useState(false);
  const [tempUnhiddenIds, setTempUnhiddenIds] = useState<Set<string>>(new Set());
  /** Pairs (with their original scope) unhidden by the bulk toggle, so switching it back off re-hides exactly these with the same audience. */
  const bulkPairsRef = useRef<
    { session_id: string; user_id: string; hide_from_athlete: boolean; hide_from_coach: boolean; hide_from_manager: boolean }[]
  >([]);

  const totals = useMemo(() => {
    const totalIls = rows.reduce((sum, r) => sum + (parseMoney(r.expected_ils) ?? 0), 0);
    return { count: rows.length, totalIls: Math.round(totalIls * 100) / 100 };
  }, [rows]);

  /** On (all currently-listed hidden workouts share that flag) vs off. */
  const globalScope = useMemo(
    () => ({
      athlete: rows.length > 0 && rows.every((r) => r.hide_from_athlete),
      coach: rows.length > 0 && rows.every((r) => r.hide_from_coach),
      manager: rows.length > 0 && rows.every((r) => r.hide_from_manager),
    }),
    [rows]
  );
  const [scopeBulkBusy, setScopeBulkBusy] = useState<"athlete" | "coach" | "manager" | null>(null);

  function showError(msg: string) {
    showToast({ message: t("common.error"), detail: msg, variant: "error" });
  }

  async function setGlobalScope(key: "athlete" | "coach" | "manager", value: boolean) {
    if (scopeBulkBusy || rows.length === 0) return;
    setScopeBulkBusy(key);
    let skipped = 0;
    const results = await Promise.all(
      rows.map((r) => {
        const next = {
          hide_from_athlete: key === "athlete" ? value : r.hide_from_athlete,
          hide_from_coach: key === "coach" ? value : r.hide_from_coach,
          hide_from_manager: key === "manager" ? value : r.hide_from_manager,
        };
        if (!next.hide_from_athlete && !next.hide_from_coach && !next.hide_from_manager) {
          skipped += 1;
          return Promise.resolve({ data: { ok: true }, error: null });
        }
        return supabase.rpc("super_user_update_hidden_scope", {
          p_session_id: r.session_id,
          p_user_id: r.athlete_user_id,
          p_hide_from_athlete: next.hide_from_athlete,
          p_hide_from_coach: next.hide_from_coach,
          p_hide_from_manager: next.hide_from_manager,
        });
      })
    );
    const failedCount = results.filter((r) => r.error || r.data?.ok !== true).length;
    setScopeBulkBusy(null);
    if (skipped > 0) {
      showError(t("superUser.scopeGlobalSkipped").replace("{n}", String(skipped)));
    } else if (failedCount > 0) {
      showError(t("superUser.unhideAllPartialError").replace("{n}", String(failedCount)));
    } else {
      showToast({ message: t("superUser.scopeGlobalUpdated"), variant: "success" });
    }
    await load();
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

  async function turnUnhideAllOn() {
    if (unhideAllBusy || rows.length === 0) {
      setUnhideAllOn(true);
      return;
    }
    setUnhideAllBusy(true);
    const pairs = rows.map((r) => ({
      session_id: r.session_id,
      user_id: r.athlete_user_id,
      hide_from_athlete: r.hide_from_athlete,
      hide_from_coach: r.hide_from_coach,
      hide_from_manager: r.hide_from_manager,
    }));
    const results = await Promise.all(
      pairs.map((p) =>
        supabase.rpc("super_user_unhide_registration", { p_session_id: p.session_id, p_user_id: p.user_id })
      )
    );
    const failedCount = results.filter((r) => r.error || r.data?.ok !== true).length;
    bulkPairsRef.current = pairs;
    setTempUnhiddenIds(new Set(rows.map((r) => r.hide_id)));
    setUnhideAllOn(true);
    setUnhideAllBusy(false);
    if (failedCount > 0) {
      showError(t("superUser.unhideAllPartialError").replace("{n}", String(failedCount)));
    } else {
      showToast({ message: t("superUser.unhideAllOnToast"), variant: "success" });
    }
  }

  async function turnUnhideAllOff() {
    setUnhideAllBusy(true);
    const pairs = bulkPairsRef.current;
    const results = await Promise.all(
      pairs.map((p) =>
        supabase.rpc("super_user_hide_registration", {
          p_session_id: p.session_id,
          p_user_id: p.user_id,
          p_hide_from_athlete: p.hide_from_athlete,
          p_hide_from_coach: p.hide_from_coach,
          p_hide_from_manager: p.hide_from_manager,
        })
      )
    );
    const failedCount = results.filter((r) => r.error || r.data?.ok !== true).length;
    bulkPairsRef.current = [];
    setTempUnhiddenIds(new Set());
    setUnhideAllOn(false);
    setUnhideAllBusy(false);
    if (failedCount > 0) {
      showError(t("superUser.unhideAllPartialError").replace("{n}", String(failedCount)));
    } else {
      showToast({ message: t("superUser.unhideAllOffToast"), variant: "success" });
    }
    await load();
  }

  const filtersLocked = unhideAllOn || unhideAllBusy;

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

      <FlatList
        style={styles.list}
        data={loading ? [] : rows}
        keyExtractor={(row) => row.hide_id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            <View style={styles.filters}>
              <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("superUser.hiddenHint")}</Text>
              <Pressable
                style={[styles.pickerTouch, filtersLocked && styles.disabledControl]}
                disabled={filtersLocked}
                onPress={() => { setPickerQ(""); setPickerOpen(true); }}
              >
                <Text style={athleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
                  {athleteLabel || t("superUser.filterAthletePlaceholder")}
                </Text>
              </Pressable>
              <View style={filtersLocked ? styles.disabledControl : undefined} pointerEvents={filtersLocked ? "none" : "auto"}>
                <CollapsibleDateRangeCard
                  start={start}
                  end={end}
                  onChange={({ start: s, end: e }) => {
                    setStart(s);
                    setEnd(e);
                  }}
                  label={t("superUser.dateRange")}
                />
              </View>
              {!filtersLocked && (athleteId || start !== defaultRange.start || end !== defaultRange.end) ? (
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

              <View style={styles.unhideAllRow}>
                <View style={styles.unhideAllCopy}>
                  <Text style={[styles.unhideAllLabel, isRTL && styles.rtlText]}>{t("superUser.unhideAllToggle")}</Text>
                  <Text style={[styles.unhideAllHint, isRTL && styles.rtlText]}>
                    {t(unhideAllOn ? "superUser.unhideAllOnHint" : "superUser.unhideAllOffHint")}
                  </Text>
                </View>
                {unhideAllBusy ? (
                  <ActivityIndicator size="small" color={theme.colors.cta} />
                ) : (
                  <AppSwitch
                    value={unhideAllOn}
                    onValueChange={(next) => void (next ? turnUnhideAllOn() : turnUnhideAllOff())}
                    onColor={theme.colors.error}
                    accessibilityLabel={t("superUser.unhideAllToggle")}
                  />
                )}
              </View>

              <View style={[styles.scopeChipsRow, isRTL && styles.scopeChipsRowRtl]}>
                <Text style={[styles.scopeCardTitle, isRTL && styles.rtlText]}>{t("superUser.scopeGlobalTitle")}</Text>
                <View style={[styles.scopeChipGroup, isRTL && styles.scopeChipGroupRtl]}>
                  {(["athlete", "coach", "manager"] as const).map((key) => {
                    const on = globalScope[key];
                    const busy = scopeBulkBusy === key;
                    const label = t(
                      key === "athlete" ? "superUser.scopeAthlete" : key === "coach" ? "superUser.scopeCoach" : "superUser.scopeManager"
                    );
                    return (
                      <Pressable
                        key={key}
                        disabled={filtersLocked || rows.length === 0 || scopeBulkBusy !== null}
                        onPress={() => void setGlobalScope(key, !on)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={label}
                        style={({ pressed }) => [
                          styles.scopeToggleChip,
                          on && styles.scopeToggleChipOn,
                          pressed && { opacity: 0.85 },
                        ]}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color={on ? theme.colors.ctaText : theme.colors.text} />
                        ) : (
                          <Text style={[styles.scopeToggleChipTxt, on && styles.scopeToggleChipTxtOn]} numberOfLines={1}>
                            {label}
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
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
            ) : null}
          </>
        }
        renderItem={loading ? () => null : ({ item, index }) => {
            const tempUnhidden = tempUnhiddenIds.has(item.hide_id);
            return (
            <FadeSlideIn delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={styles.card}>
                <View style={[styles.cardHead, isRTL && styles.cardHeadRtl]}>
                  <Text style={[styles.athleteName, isRTL && styles.rtlText]} numberOfLines={1}>
                    {item.athlete_name}
                  </Text>
                  <View style={[styles.badge, tempUnhidden && styles.badgeVisible]}>
                    <Text style={[styles.badgeTxt, tempUnhidden && styles.badgeTxtVisible]}>
                      {t(tempUnhidden ? "superUser.temporarilyVisible" : "superUser.hiddenBadge")}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.meta, isRTL && styles.rtlText]}>
                  {formatISODateFull(item.session_date, language)} ·{" "}
                  {formatSessionTimeRange(item.start_time, item.duration_minutes)}
                </Text>
                {item.coach_name ? (
                  <Text style={[styles.meta, isRTL && styles.rtlText]}>{item.coach_name}</Text>
                ) : null}
                <View style={[styles.scopeChips, isRTL && styles.scopeChipsRtl]}>
                  {item.hide_from_athlete ? (
                    <View style={styles.scopeChip}>
                      <Text style={styles.scopeChipTxt}>{t("superUser.scopeAthlete")}</Text>
                    </View>
                  ) : null}
                  {item.hide_from_coach ? (
                    <View style={styles.scopeChip}>
                      <Text style={styles.scopeChipTxt}>{t("superUser.scopeCoach")}</Text>
                    </View>
                  ) : null}
                  {item.hide_from_manager ? (
                    <View style={styles.scopeChip}>
                      <Text style={styles.scopeChipTxt}>{t("superUser.scopeManager")}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.expected, isRTL && styles.rtlText]}>
                  {t("superUser.expectedAmount")}: {parseMoney(item.expected_ils) ?? 0} ₪
                </Text>
                <Text style={[styles.metaMuted, isRTL && styles.rtlText]}>
                  {t("superUser.hiddenAt")}: {formatISODateFull(item.hidden_at.slice(0, 10), language)}
                  {item.hidden_by_name ? ` · ${t("superUser.hiddenBy")}: ${item.hidden_by_name}` : ""}
                </Text>
                {tempUnhidden ? null : (
                  <Pressable
                    disabled={busyId === item.hide_id || filtersLocked}
                    style={({ pressed }) => [
                      styles.unhideBtn,
                      pressed && { opacity: 0.9 },
                      (busyId === item.hide_id || filtersLocked) && { opacity: 0.6 },
                    ]}
                    onPress={() => confirmUnhide(item)}
                  >
                    <Text style={styles.unhideBtnTxt}>{t("superUser.unhide")}</Text>
                  </Pressable>
                )}
              </View>
            </FadeSlideIn>
            );
          }
        }
        ListEmptyComponent={loading ? null : <EmptyState icon="👁️" title={t("superUser.noRecords")} isRTL={isRTL} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  list: { flex: 1 },
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
  disabledControl: { opacity: 0.5 },
  unhideAllRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
  },
  unhideAllCopy: { flex: 1 },
  unhideAllLabel: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  unhideAllHint: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  scopeChipsRow: {
    marginTop: theme.spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  scopeChipsRowRtl: { flexDirection: "row-reverse" },
  scopeCardTitle: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 12 },
  scopeChipGroup: { flexDirection: "row", gap: 6 },
  scopeChipGroupRtl: { flexDirection: "row-reverse" },
  scopeToggleChip: {
    minWidth: 40,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  scopeToggleChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  scopeToggleChipTxt: { color: theme.colors.text, fontWeight: "700", fontSize: 12 },
  scopeToggleChipTxtOn: { color: theme.colors.ctaText },
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
  badgeVisible: { backgroundColor: theme.colors.successBg },
  badgeTxtVisible: { color: theme.colors.success },
  meta: { color: theme.colors.textSoft, fontSize: 13 },
  scopeChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  scopeChipsRtl: { flexDirection: "row-reverse" },
  scopeChip: {
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  scopeChipTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 10 },
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
