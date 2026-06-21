import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { AppSearchSheet } from "./AppSearchSheet";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { searchStaffAthletes, type StaffAthleteSearchHit } from "../lib/staffAthleteSearch";
import { fetchStaffUpcomingRegisteredSessions, type AthleteUpcomingSession } from "../lib/staffAthleteUpcomingSessions";
import { formatISODateWeekdayDayMonth } from "../lib/dateFormat";
import { formatSessionStartTime } from "../lib/sessionTime";
import { firstWordOfDisplayName } from "../lib/displayName";

type Props = {
  variant: "coach" | "manager";
};

function sessionPath(variant: Props["variant"], id: string): Href {
  return (variant === "manager" ? `/(app)/manager/session/${id}` : `/(app)/coach/session/${id}`) as Href;
}

export function StaffAthleteScheduleLookup({ variant }: Props) {
  const { language, t, isRTL } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StaffAthleteSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StaffAthleteSearchHit | null>(null);
  const [upcoming, setUpcoming] = useState<AthleteUpcomingSession[]>([]);
  const [loadingUpcoming, setLoadingUpcoming] = useState(false);
  const upcomingSeqRef = useRef(0);

  const runSearch = useCallback(async (term: string) => {
    setSearching(true);
    try {
      setHits(await searchStaffAthletes(term));
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setUpcoming([]);
      return;
    }
    const seq = ++upcomingSeqRef.current;
    setLoadingUpcoming(true);
    void fetchStaffUpcomingRegisteredSessions(selected).then((rows) => {
      if (seq !== upcomingSeqRef.current) return;
      setUpcoming(rows);
      setLoadingUpcoming(false);
    });
  }, [selected]);

  function clearSelection() {
    upcomingSeqRef.current += 1;
    setSelected(null);
    setUpcoming([]);
    setLoadingUpcoming(false);
  }

  function pickAthlete(hit: StaffAthleteSearchHit) {
    setSheetOpen(false);
    setQuery("");
    setHits([]);
    setSelected(hit);
  }

  function openSheet() {
    setQuery("");
    setHits([]);
    setSheetOpen(true);
  }

  return (
    <>
      {selected ? (
        <View style={styles.panel}>
          <View style={[styles.panelHead, isRTL && styles.panelHeadRtl]}>
            <Text style={[styles.panelName, isRTL && styles.rtlText]} numberOfLines={1}>
              {selected.fullName}
              {selected.kind === "manual" ? (
                <Text style={styles.quickAddTag}> · {t("dashboard.financeQuickAdd")}</Text>
              ) : null}
            </Text>
            <Pressable
              onPress={clearSelection}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
              style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.clearBtnTxt}>{"×"}</Text>
            </Pressable>
          </View>

          {loadingUpcoming ? (
            <ActivityIndicator color={theme.colors.cta} style={styles.loader} />
          ) : upcoming.length === 0 ? (
            <Text style={[styles.empty, isRTL && styles.rtlText]}>{t("staffScheduleLookup.noUpcoming")}</Text>
          ) : (
            <View style={styles.sessionList}>
              {upcoming.map((s, i) => (
                <Pressable
                  key={s.sessionId}
                  onPress={() => router.push(sessionPath(variant, s.sessionId))}
                  style={({ pressed }) => [
                    styles.sessionRow,
                    isRTL && styles.sessionRowRtl,
                    i > 0 && styles.sessionRowBorder,
                    pressed && styles.sessionRowPressed,
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.sessionWhen, isRTL && styles.rtlText]} numberOfLines={1}>
                    {formatISODateWeekdayDayMonth(s.sessionDate, language)}
                    <Text style={styles.sessionDot}>{" · "}</Text>
                    {formatSessionStartTime(s.startTime)}
                  </Text>
                  <Text style={[styles.sessionCoach, isRTL && styles.rtlText]} numberOfLines={1}>
                    {firstWordOfDisplayName(s.coachName)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          <Pressable
            onPress={openSheet}
            style={({ pressed }) => [styles.changeBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <Text style={[styles.changeBtnTxt, isRTL && styles.rtlText]}>{t("staffScheduleLookup.changeAthlete")}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={openSheet}
          style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
          accessibilityRole="button"
          accessibilityLabel={t("staffScheduleLookup.placeholder")}
        >
          <Text style={styles.triggerIcon} importantForAccessibility="no">
            {"⌕"}
          </Text>
          <Text style={[styles.triggerLabel, isRTL && styles.rtlText]} numberOfLines={1}>
            {t("staffScheduleLookup.placeholder")}
          </Text>
        </Pressable>
      )}

      <AppSearchSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t("staffScheduleLookup.sheetTitle")}
        subtitle={t("staffScheduleLookup.sheetHint")}
        dismissLabel={t("common.cancel")}
        isRTL={isRTL}
        backdropAccessibilityLabel={t("common.cancel")}
        sheetHeightPct={0.78}
        searchConfig={{
          value: query,
          onChangeText: setQuery,
          onSearch: runSearch,
          placeholder: t("staffScheduleLookup.searchPlaceholder"),
          loading: searching,
          accessibilityLabel: t("staffScheduleLookup.searchPlaceholder"),
          autoFocus: true,
        }}
        data={hits}
        keyExtractor={(item) => (item.kind === "app" ? `a:${item.id}` : `m:${item.id}`)}
        ListEmptyComponent={
          <Text style={[styles.sheetEmpty, isRTL && styles.rtlText]}>
            {searching ? t("common.loading") : t("staffScheduleLookup.noAthletes")}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => pickAthlete(item)}
            style={({ pressed }) => [styles.hitRow, pressed && styles.hitRowPressed]}
          >
            <Text style={[styles.hitName, isRTL && styles.rtlText]} numberOfLines={1}>
              {item.fullName}
              {item.kind === "manual" ? (
                <Text style={styles.hitQuickAdd}> · {t("dashboard.financeQuickAdd")}</Text>
              ) : null}
            </Text>
            {item.kind === "app" && item.phone ? (
              <Text style={[styles.hitMeta, isRTL && styles.rtlText]} numberOfLines={1}>
                {item.phone}
              </Text>
            ) : item.kind === "app" && item.username ? (
              <Text style={[styles.hitMeta, isRTL && styles.rtlText]} numberOfLines={1}>
                @{item.username}
              </Text>
            ) : item.kind === "manual" && item.phone ? (
              <Text style={[styles.hitMeta, isRTL && styles.rtlText]} numberOfLines={1}>
                {item.phone}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  triggerPressed: { opacity: 0.92, backgroundColor: theme.colors.surfaceElevated },
  triggerIcon: {
    fontSize: 17,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 17,
  },
  triggerLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.textMuted,
  },
  rtlText: { textAlign: "right", writingDirection: "rtl" },
  panel: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  panelHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  panelHeadRtl: { flexDirection: "row-reverse" },
  panelName: { flex: 1, fontSize: 15, fontWeight: "800", color: theme.colors.text },
  quickAddTag: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.backgroundAlt,
  },
  clearBtnTxt: { fontSize: 18, fontWeight: "700", color: theme.colors.textMuted, lineHeight: 18 },
  loader: { marginVertical: 10 },
  empty: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textMuted,
    paddingVertical: 6,
    lineHeight: 18,
  },
  sessionList: { marginTop: 2 },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 9,
  },
  sessionRowRtl: { flexDirection: "row-reverse" },
  sessionRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  sessionRowPressed: { opacity: 0.88 },
  sessionWhen: { flex: 1, fontSize: 13, fontWeight: "700", color: theme.colors.text, minWidth: 0 },
  sessionDot: { fontWeight: "600", color: theme.colors.textSoft },
  sessionCoach: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, maxWidth: "36%" },
  changeBtn: { alignSelf: "flex-start", paddingTop: 8, paddingBottom: 2 },
  changeBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.cta },
  sheetEmpty: {
    textAlign: "center",
    color: theme.colors.textMuted,
    fontWeight: "600",
    paddingVertical: theme.spacing.lg,
  },
  hitRow: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  hitRowPressed: { backgroundColor: theme.colors.surfaceElevated },
  hitName: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  hitQuickAdd: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  hitMeta: { marginTop: 2, fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
});
