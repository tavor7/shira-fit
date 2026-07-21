import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from "react-native";
import { Stack, useLocalSearchParams, router, useFocusEffect, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { parseManagerPeriodMode } from "../lib/managerPeriodMode";
import { useAppAlert } from "../context/AppAlertContext";
import { formatISODateFull } from "../lib/dateFormat";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { EmptyState } from "../components/EmptyState";
import {
  parseCapacityMismatch,
  type CapacityMismatchSession,
} from "../lib/managerWeeklyStats";
import { CrossfadeSwap } from "../components/CrossfadeSwap";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { PressableScale } from "../components/PressableScale";

function formatSessionTimeShort(isoTime: string): string {
  const s = String(isoTime ?? "").trim();
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export default function ManagerCapacityMismatchScreen() {
  const { language, isRTL, t } = useI18n();
  const { showOk, showConfirm } = useAppAlert();
  const params = useLocalSearchParams<{ anchor?: string; periodMode?: string }>();
  const anchor = String(params.anchor ?? "").trim();
  const periodMode = parseManagerPeriodMode(
    typeof params.periodMode === "string" ? params.periodMode : undefined
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<CapacityMismatchSession[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const skipFocusReloadRef = useRef(true);

  const load = useCallback(async () => {
    if (!anchor) {
      setError(t("common.error"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.rpc("manager_capacity_mismatch", {
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
    const payload = parseCapacityMismatch(raw);
    const ids = payload.sessions.map((s) => s.session_id);
    const noteBySession: Record<string, string> = {};
    if (ids.length > 0) {
      const { data: notesData } = await supabase
        .from("session_notes")
        .select("session_id, body, created_at")
        .in("session_id", ids)
        .order("created_at", { ascending: false });
      for (const row of (notesData as { session_id: string; body: string }[] | null) ?? []) {
        const sid = String(row.session_id ?? "");
        if (!sid || noteBySession[sid]) continue;
        const body = String(row.body ?? "").trim();
        if (body) noteBySession[sid] = body;
      }
    }
    setSessions(
      payload.sessions.map((s) => ({
        ...s,
        note: noteBySession[s.session_id] ?? null,
      }))
    );
  }, [anchor, periodMode, t]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useFocusEffect(
    useCallback(() => {
      if (skipFocusReloadRef.current) {
        skipFocusReloadRef.current = false;
        return;
      }
      if (!anchor) return;
      setRefreshNonce((n) => n + 1);
    }, [anchor])
  );

  const rangeLabel =
    rangeStart && rangeEnd
      ? rangeStart === rangeEnd
        ? formatISODateFull(rangeStart, language)
        : `${formatISODateFull(rangeStart, language)} – ${formatISODateFull(rangeEnd, language)}`
      : "";

  const updateMaxToRegistered = useCallback(
    async (s: CapacityMismatchSession) => {
      setUpdatingId(s.session_id);
      const { error: err } = await supabase
        .from("training_sessions")
        .update({ max_participants: s.registered_count })
        .eq("id", s.session_id);
      setUpdatingId(null);
      if (err) {
        showOk(t("common.error"), err.message);
        return;
      }
      setRefreshNonce((n) => n + 1);
    },
    [showOk, t]
  );

  function openEditParticipants(sessionId: string) {
    router.push(`/(app)/manager/session/${sessionId}` as Href);
  }

  function confirmUpdateMax(s: CapacityMismatchSession) {
    if (s.registered_count <= 0) return;
    showConfirm({
      title: t("dashboard.capacityMismatchUpdateTitle"),
      message: t("dashboard.capacityMismatchUpdateMessage")
        .replace("{max}", String(s.max_participants))
        .replace("{registered}", String(s.registered_count)),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("dashboard.capacityMismatchUpdateConfirm"),
      onConfirm: () => void updateMaxToRegistered(s),
    });
  }

  return (
    <>
      <Stack.Screen options={{ title: t("dashboard.capacityMismatchTitle") }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ManagerOverviewHubTabs />
        <Text style={[styles.h, isRTL && styles.rtl]}>{t("dashboard.capacityMismatchTitle")}</Text>
        {rangeLabel ? <Text style={[styles.sub, isRTL && styles.rtl]}>{rangeLabel}</Text> : null}
        <Text style={[styles.hint, isRTL && styles.rtl]}>{t("dashboard.capacityMismatchHint")}</Text>

        <CrossfadeSwap
          loading={loading}
          skeleton={
            <View style={styles.skeletonList}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          }
        >
          {error ? (
          <Text style={[styles.err, isRTL && styles.rtl]}>{error}</Text>
        ) : sessions.length === 0 ? (
          <EmptyState icon="✅" title={t("dashboard.capacityMismatchEmpty")} isRTL={isRTL} />
        ) : (
          sessions.map((s, index) => {
            const diff = s.registered_count - s.max_participants;
            const isOver = diff > 0;
            const diffLabel = isOver
              ? t("dashboard.capacityMismatchOver").replace("{n}", String(diff))
              : t("dashboard.capacityMismatchUnder").replace("{n}", String(Math.abs(diff)));
            const canSetMax = s.registered_count > 0;
            return (
              <FadeSlideIn key={s.session_id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={styles.card}>
                <PressableScale
                  onPress={() => router.push(`/(app)/manager/session/${s.session_id}` as Href)}
                  style={({ pressed }) => [styles.cardHead, pressed && styles.cardHeadPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t("dashboard.capacityMismatchOpenSession")}
                >
                  <Text style={[styles.cardDate, isRTL && styles.rtl]} numberOfLines={2}>
                    {formatISODateFull(s.session_date, language)} · {formatSessionTimeShort(s.start_time)}
                    {" · "}
                    {s.coach_name?.trim() || "—"}
                  </Text>
                  <View style={[styles.statsRow, isRTL && styles.statsRowRtl]}>
                    <Text
                      style={[styles.diffLine, isOver ? styles.diffOver : styles.diffUnder, isRTL && styles.rtl]}
                      numberOfLines={1}
                    >
                      {diffLabel}
                    </Text>
                    <Text style={[styles.cardCounts, isRTL && styles.cardCountsRtl]} numberOfLines={1}>
                      {t("dashboard.capacityMismatchCounts")
                        .replace("{max}", String(s.max_participants))
                        .replace("{registered}", String(s.registered_count))}
                    </Text>
                  </View>
                  {s.note ? (
                    <View style={styles.noteBox}>
                      <Text style={[styles.noteLbl, isRTL && styles.rtl]}>{t("dashboard.capacityMismatchNote")}</Text>
                      <Text style={[styles.noteBody, isRTL && styles.rtl]} numberOfLines={4}>
                        {s.note}
                      </Text>
                    </View>
                  ) : null}
                </PressableScale>
                <View style={[styles.cardActions, isRTL && styles.cardActionsRtl]}>
                  {canSetMax ? (
                    <Pressable
                      onPress={() => confirmUpdateMax(s)}
                      disabled={updatingId === s.session_id}
                      style={({ pressed }) => [
                        styles.btnPrimary,
                        styles.btnHalf,
                        pressed && { opacity: 0.9 },
                        updatingId === s.session_id && styles.btnDisabled,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={t("dashboard.capacityMismatchUpdateBtn").replace(
                        "{n}",
                        String(s.registered_count)
                      )}
                    >
                      <Text style={styles.btnPrimaryTxt} numberOfLines={1}>
                        {t("dashboard.capacityMismatchUpdateBtn").replace("{n}", String(s.registered_count))}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => openEditParticipants(s.session_id)}
                    style={({ pressed }) => [
                      canSetMax ? styles.btnSecondary : styles.btnPrimary,
                      canSetMax ? styles.btnHalf : styles.btnFull,
                      pressed && { opacity: 0.9 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("dashboard.capacityMismatchEditParticipants")}
                  >
                    <Text
                      style={canSetMax ? styles.btnSecondaryTxt : styles.btnPrimaryTxt}
                      numberOfLines={1}
                    >
                      {t("dashboard.capacityMismatchEditParticipants")}
                    </Text>
                  </Pressable>
                </View>
              </View>
              </FadeSlideIn>
            );
          })
        )}
        </CrossfadeSwap>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  skeletonList: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  h: { fontSize: 22, fontWeight: "900", color: theme.colors.text, marginBottom: 4 },
  sub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  hint: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginBottom: theme.spacing.md },
  rtl: { textAlign: "right", writingDirection: "rtl" },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 12 },
  muted: { color: theme.colors.textSoft, fontWeight: "600", marginTop: 12 },
  card: {
    marginBottom: 8,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  cardHead: { paddingVertical: 10, paddingHorizontal: 12 },
  cardHeadPressed: { opacity: 0.9 },
  cardDate: { fontSize: 14, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 6,
  },
  statsRowRtl: { flexDirection: "row-reverse" },
  diffLine: { flexShrink: 1, fontSize: 14, fontWeight: "800" },
  diffOver: { color: theme.colors.error },
  diffUnder: { color: theme.colors.info },
  cardCounts: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.alertSubject,
    textAlign: "right",
  },
  cardCountsRtl: { textAlign: "left" },
  noteBox: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  noteLbl: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  noteBody: { fontSize: 13, fontWeight: "600", color: theme.colors.text, lineHeight: 18 },
  cardActions: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
  },
  cardActionsRtl: { flexDirection: "row-reverse" },
  btnHalf: { flex: 1, minWidth: 0 },
  btnFull: { flex: 1 },
  btnPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.ctaText, textAlign: "center" },
  btnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSecondaryTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.text, textAlign: "center" },
  btnDisabled: { opacity: 0.6 },
});
