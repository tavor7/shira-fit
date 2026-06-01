import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Stack, useLocalSearchParams, router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { parseManagerPeriodMode } from "../lib/managerPeriodMode";
import { useAppAlert } from "../context/AppAlertContext";
import { formatISODateFull } from "../lib/dateFormat";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { ParticipantAttendanceList } from "../components/ParticipantAttendanceList";
import {
  parseMissingAttendance,
  type MissingAttendanceSession,
} from "../lib/managerWeeklyStats";

function formatSessionTimeShort(isoTime: string): string {
  const s = String(isoTime ?? "").trim();
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export default function ManagerMissingAttendanceScreen() {
  const { language, isRTL, t } = useI18n();
  const { showOk } = useAppAlert();
  const params = useLocalSearchParams<{ anchor?: string; periodMode?: string }>();
  const anchor = String(params.anchor ?? "").trim();
  const periodMode = parseManagerPeriodMode(
    typeof params.periodMode === "string" ? params.periodMode : undefined
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<MissingAttendanceSession[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const load = useCallback(async () => {
    if (!anchor) {
      setError(t("common.error"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.rpc("manager_weekly_stats", {
      p_anchor: anchor,
      p_mode: periodMode,
    });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    const raw = data as Record<string, unknown> | null;
    if (!raw?.ok) {
      setError(String(raw?.error ?? t("common.error")));
      return;
    }
    setRangeStart(String(raw.week_start ?? ""));
    setRangeEnd(String(raw.week_end ?? ""));
    const payload = parseMissingAttendance(raw.missing_attendance);
    setSessions(payload.sessions);
    if (expandedId && !payload.sessions.some((s) => s.session_id === expandedId)) {
      setExpandedId(null);
    }
  }, [anchor, periodMode, t]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  const rangeLabel =
    rangeStart && rangeEnd
      ? rangeStart === rangeEnd
        ? formatISODateFull(rangeStart, language)
        : `${formatISODateFull(rangeStart, language)} – ${formatISODateFull(rangeEnd, language)}`
      : "";

  function onAttendanceChanged() {
    setRefreshNonce((n) => n + 1);
  }

  const removeAthlete = useCallback(
    async (sessionId: string, userId: string) => {
      const { data, error } = await supabase.rpc("manager_remove_athlete", {
        p_session_id: sessionId,
        p_user_id: userId,
      });
      if (error) showOk(t("common.error"), error.message);
      else if (data?.ok) onAttendanceChanged();
      else showOk(t("common.failed"), String(data?.error ?? ""));
    },
    [showOk, t]
  );

  const removeManual = useCallback(
    async (sessionId: string, manualId: string) => {
      const { data, error } = await supabase.rpc("remove_manual_participant_from_session", {
        p_session_id: sessionId,
        p_manual_participant_id: manualId,
      });
      if (error) showOk(t("common.error"), error.message);
      else if (data?.ok) onAttendanceChanged();
      else showOk(t("common.failed"), String(data?.error ?? ""));
    },
    [showOk, t]
  );

  return (
    <>
      <Stack.Screen options={{ title: t("dashboard.missingAttendanceTitle") }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ManagerOverviewHubTabs />
        <Text style={[styles.h, isRTL && styles.rtl]}>{t("dashboard.missingAttendanceTitle")}</Text>
        {rangeLabel ? <Text style={[styles.sub, isRTL && styles.rtl]}>{rangeLabel}</Text> : null}
        <Text style={[styles.hint, isRTL && styles.rtl]}>{t("dashboard.missingAttendanceHint")}</Text>

        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.cta} style={{ marginTop: 24 }} />
        ) : error ? (
          <Text style={[styles.err, isRTL && styles.rtl]}>{error}</Text>
        ) : sessions.length === 0 ? (
          <Text style={[styles.muted, isRTL && styles.rtl]}>{t("dashboard.missingAttendanceEmpty")}</Text>
        ) : (
          sessions.map((s) => {
            const open = expandedId === s.session_id;
            return (
              <View key={s.session_id} style={styles.card}>
                <Pressable
                  onPress={() => setExpandedId(open ? null : s.session_id)}
                  style={({ pressed }) => [styles.cardHead, pressed && styles.cardHeadPressed]}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                >
                  <View style={[styles.cardHeadMain, isRTL && styles.cardHeadMainRtl]}>
                    <Text style={[styles.cardDate, isRTL && styles.rtl]}>
                      {formatISODateFull(s.session_date, language)} · {formatSessionTimeShort(s.start_time)}
                    </Text>
                    <Text style={[styles.cardMeta, isRTL && styles.rtl]} numberOfLines={1}>
                      {s.coach_name?.trim() || "—"} ·{" "}
                      {t("dashboard.missingAttendanceUnset").replace("{n}", String(s.unset_count))}
                    </Text>
                  </View>
                  <Text style={styles.chev}>{open ? "▾" : "▸"}</Text>
                </Pressable>
                {open ? (
                  <View style={styles.cardBody}>
                    <Pressable
                      onPress={() => router.push(`/(app)/manager/session/${s.session_id}` as Href)}
                      style={({ pressed }) => [styles.openSessionBtn, pressed && { opacity: 0.9 }]}
                    >
                      <Text style={styles.openSessionBtnTxt}>{t("dashboard.missingAttendanceOpenSession")}</Text>
                    </Pressable>
                    <Text style={[styles.timeRange, isRTL && styles.rtl]}>
                      {formatSessionTimeRange(s.start_time, s.duration_minutes)}
                    </Text>
                    <ParticipantAttendanceList
                      sessionId={s.session_id}
                      refreshNonce={refreshNonce}
                      onChanged={onAttendanceChanged}
                      showMarkAllArrived
                      onRemoveAthlete={(userId) => removeAthlete(s.session_id, userId)}
                      onRemoveManualParticipant={(manualId) => removeManual(s.session_id, manualId)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  h: { fontSize: 22, fontWeight: "900", color: theme.colors.text, marginBottom: 4 },
  sub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  hint: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginBottom: theme.spacing.md },
  rtl: { textAlign: "right", writingDirection: "rtl" },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 12 },
  muted: { color: theme.colors.textSoft, fontWeight: "600", marginTop: 12 },
  card: {
    marginBottom: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  cardHeadPressed: { opacity: 0.9 },
  cardHeadMain: { flex: 1, minWidth: 0 },
  cardHeadMainRtl: { alignItems: "flex-end" },
  cardDate: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  cardMeta: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted, marginTop: 2 },
  chev: { color: theme.colors.textSoft, fontSize: 12, fontWeight: "700" },
  cardBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    gap: 8,
  },
  openSessionBtn: {
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  openSessionBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.cta },
  timeRange: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
});
