import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { formatISODateWeekdayDayMonth } from "../lib/dateFormat";
import { formatSessionStartTime, hasSessionNotStarted } from "../lib/sessionTime";
import { fetchActiveSignupCountsBySession } from "../lib/sessionSignupCounts";
import { weekBoundsSunday } from "../lib/studioWeek";
import { staffMoveSessionParticipant } from "../lib/staffMoveParticipant";
import { moveParticipantErrorDetail } from "../lib/moveParticipantErrors";

export type MoveParticipantTarget = {
  kind: "registered" | "manual";
  name: string;
  userId?: string;
  manualId?: string;
};

type SessionPick = {
  id: string;
  session_date: string;
  start_time: string;
  max_participants: number;
  coach_id: string;
  coachName: string;
  count: number;
};

type FullChoice = "cancel" | "increase" | "over";

type Props = {
  visible: boolean;
  onClose: () => void;
  fromSessionId: string;
  fromSessionDate: string;
  fromMaxParticipants: number;
  fromParticipantCount: number;
  participant: MoveParticipantTarget | null;
  /** When set, only list sessions for this coach (coach role). */
  coachFilterUserId?: string | null;
  isManager: boolean;
  onMoved: () => void;
};

export function MoveParticipantSheet({
  visible,
  onClose,
  fromSessionId,
  fromSessionDate,
  fromMaxParticipants,
  fromParticipantCount,
  participant,
  coachFilterUserId,
  isManager,
  onMoved,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showAlert } = useAppAlert();
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [justMoved, setJustMoved] = useState(false);
  const [sessions, setSessions] = useState<SessionPick[]>([]);
  const [picked, setPicked] = useState<SessionPick | null>(null);
  const [fullChoice, setFullChoice] = useState<FullChoice | null>(null);
  const sendProgress = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  const canOfferDecreaseSource =
    fromMaxParticipants < 12 &&
    fromMaxParticipants > 1 &&
    fromParticipantCount >= fromMaxParticipants;

  const loadSessions = useCallback(async () => {
    if (!fromSessionDate) return;
    setLoading(true);
    const { start, end } = weekBoundsSunday(fromSessionDate);
    let query = supabase
      .from("training_sessions")
      .select("id, session_date, start_time, max_participants, coach_id, trainer:profiles!coach_id(full_name)")
      .gte("session_date", start)
      .lte("session_date", end)
      .neq("id", fromSessionId)
      .order("session_date", { ascending: true })
      .order("start_time", { ascending: true });
    if (coachFilterUserId) {
      query = query.eq("coach_id", coachFilterUserId);
    }
    const { data, error } = await query;
    if (error) {
      setSessions([]);
      setLoading(false);
      return;
    }
    const rows = ((data ?? []) as Array<{
      id: string;
      session_date: string;
      start_time: string;
      max_participants: number;
      coach_id: string;
      trainer: { full_name: string } | { full_name: string }[] | null;
    }>).filter((s) => hasSessionNotStarted(s.session_date, s.start_time));
    const ids = rows.map((r) => r.id);
    const counts = ids.length ? await fetchActiveSignupCountsBySession(ids) : {};
    setSessions(
      rows.map((r) => {
        const tr = r.trainer;
        const coachName = tr ? (Array.isArray(tr) ? tr[0]?.full_name : tr.full_name) ?? "—" : "—";
        return {
          id: r.id,
          session_date: r.session_date,
          start_time: r.start_time,
          max_participants: r.max_participants,
          coach_id: r.coach_id,
          coachName,
          count: counts[r.id] ?? 0,
        };
      })
    );
    setLoading(false);
  }, [coachFilterUserId, fromSessionDate, fromSessionId]);

  useEffect(() => {
    if (!visible) {
      setPicked(null);
      setFullChoice(null);
      setJustMoved(false);
      sendProgress.setValue(0);
      return;
    }
    void loadSessions();
  }, [visible, loadSessions, sendProgress]);

  const destFull = picked != null && picked.count >= picked.max_participants;

  const preview = useMemo(() => {
    if (!picked || !participant) return null;
    const srcAfter = fromParticipantCount - 1;
    let destAfter = picked.count + 1;
    let destMax = picked.max_participants;
    if (fullChoice === "increase") {
      destMax += 1;
    }
    return {
      srcLine: `${srcAfter}/${fromMaxParticipants}`,
      destLine: `${destAfter}/${destMax}${fullChoice === "over" ? " *" : ""}`,
    };
  }, [picked, participant, fromParticipantCount, fromMaxParticipants, fullChoice]);

  function handleClose() {
    if (moving || justMoved) return;
    onClose();
  }

  async function runMove(opts: {
    allowOverCapacity?: boolean;
    increaseDestMax?: boolean;
    decreaseSourceMax?: boolean;
  }) {
    if (!participant || !picked) return;
    setMoving(true);
    const result = await staffMoveSessionParticipant({
      fromSessionId,
      toSessionId: picked.id,
      userId: participant.kind === "registered" ? participant.userId : undefined,
      manualParticipantId: participant.kind === "manual" ? participant.manualId : undefined,
      allowOverCapacity: opts.allowOverCapacity,
      increaseDestMax: opts.increaseDestMax,
      decreaseSourceMax: opts.decreaseSourceMax,
    });
    setMoving(false);
    if (!result.ok) {
      showToast({
        message: t("moveParticipant.failed"),
        detail: moveParticipantErrorDetail(result.error, t),
        variant: "error",
      });
      return;
    }
    showToast({ message: t("moveParticipant.success"), variant: "success" });
    setJustMoved(true);
    if (!reduceMotionRef.current) {
      await new Promise<void>((resolve) => {
        Animated.timing(sendProgress, {
          toValue: 1,
          duration: 480,
          easing: theme.motion.easeOut,
          useNativeDriver: true,
        }).start(() => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    onMoved();
    onClose();

    if (canOfferDecreaseSource && !opts.decreaseSourceMax) {
      showAlert({
        title: t("managerSession.decreaseGroupSizeTitle"),
        message: t("managerSession.decreaseGroupSizeMessage"),
        actions: [
          { label: t("common.cancel"), variant: "secondary", onPress: () => undefined },
          {
            label: t("managerSession.decreaseGroupSizeConfirm"),
            variant: "primary",
            onPress: () => {
              void (async () => {
                const { error } = await supabase
                  .from("training_sessions")
                  .update({ max_participants: fromMaxParticipants - 1 })
                  .eq("id", fromSessionId);
                if (error) {
                  showToast({ message: t("common.error"), detail: error.message, variant: "error" });
                } else {
                  onMoved();
                }
              })();
            },
          },
        ],
      });
    }
  }

  function confirmMove() {
    if (!picked) return;
    if (destFull && !fullChoice) return;
    if (destFull && fullChoice === "cancel") {
      setPicked(null);
      setFullChoice(null);
      return;
    }
    void runMove({
      allowOverCapacity: fullChoice === "over",
      increaseDestMax: fullChoice === "increase",
    });
  }

  function selectSession(row: SessionPick) {
    setPicked(row);
    setFullChoice(null);
  }

  const listHeader = (
    <View style={styles.listHeader}>
      {participant ? (
        <Text style={[styles.participantName, isRTL && styles.rtlText]} numberOfLines={2}>
          {participant.name}
        </Text>
      ) : null}
      <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("moveParticipant.pickHint")}</Text>
    </View>
  );

  const sendDir = isRTL ? -1 : 1;
  const confirmBody = picked && participant ? (
    <Animated.View
      style={[
        styles.confirmBlock,
        {
          opacity: sendProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [
            { translateX: sendProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 48 * sendDir] }) },
          ],
        },
      ]}
    >
      <Text style={[styles.confirmTitle, isRTL && styles.rtlText]}>{t("moveParticipant.confirmTitle")}</Text>
      <Text style={[styles.confirmSession, isRTL && styles.rtlText]}>
        {formatISODateWeekdayDayMonth(picked.session_date, language)} · {formatSessionStartTime(picked.start_time)}
      </Text>
      <Text style={[styles.confirmCoach, isRTL && styles.rtlText]}>{picked.coachName}</Text>
      {preview ? (
        <View style={[styles.previewRow, isRTL && styles.previewRowRtl]}>
          <View style={styles.previewCell}>
            <Text style={[styles.previewLbl, isRTL && styles.rtlText]}>{t("moveParticipant.from")}</Text>
            <Text style={styles.previewVal}>
              {fromParticipantCount}/{fromMaxParticipants} → {preview.srcLine}
            </Text>
          </View>
          <View style={styles.previewCell}>
            <Text style={[styles.previewLbl, isRTL && styles.rtlText]}>{t("moveParticipant.to")}</Text>
            <Text style={styles.previewVal}>
              {picked.count}/{picked.max_participants} → {preview.destLine}
            </Text>
          </View>
        </View>
      ) : null}
      {destFull && !fullChoice ? (
        <View style={styles.fullBlock}>
          <Text style={[styles.fullTitle, isRTL && styles.rtlText]}>{t("moveParticipant.fullTitle")}</Text>
          <Text style={[styles.fullMsg, isRTL && styles.rtlText]}>{t("moveParticipant.fullMessage")}</Text>
          <PrimaryButton
            label={t("moveParticipant.increaseCap")}
            onPress={() => setFullChoice("increase")}
            disabled={moving}
            style={styles.fullBtn}
          />
          <Pressable
            onPress={() => setFullChoice("over")}
            disabled={moving}
            style={({ pressed }) => [styles.fullSecondary, pressed && { opacity: 0.88 }]}
          >
            <Text style={styles.fullSecondaryTxt}>{t("moveParticipant.overCap")}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setPicked(null);
              setFullChoice(null);
            }}
            disabled={moving}
            style={({ pressed }) => [styles.fullGhost, pressed && { opacity: 0.88 }]}
          >
            <Text style={styles.fullGhostTxt}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.confirmActions}>
          <PrimaryButton
            label={moving ? t("common.loading") : t("moveParticipant.confirmMove")}
            onPress={confirmMove}
            loading={moving}
            success={justMoved}
            loadingLabel={t("common.loading")}
            disabled={(destFull && !fullChoice) || justMoved}
          />
          <Pressable
            onPress={() => {
              setPicked(null);
              setFullChoice(null);
            }}
            disabled={moving || justMoved}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={[styles.backBtnTxt, isRTL && styles.rtlText]}>{t("moveParticipant.backToList")}</Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  ) : null;

  return (
    <AppModal
      visible={visible}
      onClose={handleClose}
      variant="sheet"
      maxHeightPct={0.88}
      backdropAccessibilityLabel={t("common.cancel")}
    >
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Text style={[styles.title, isRTL && styles.rtlText]}>{t("moveParticipant.title")}</Text>
        <Pressable onPress={handleClose} hitSlop={12} disabled={moving}>
          <Text style={styles.close}>{t("common.cancel")}</Text>
        </Pressable>
      </View>

      {picked ? (
        confirmBody
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.cta} />
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={listHeader}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.empty, isRTL && styles.rtlText]}>{t("moveParticipant.noSessions")}</Text>
          }
          renderItem={({ item }) => {
            const full = item.count >= item.max_participants;
            return (
              <Pressable
                onPress={() => selectSession(item)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                accessibilityRole="button"
              >
                <View style={[styles.rowMain, isRTL && styles.rowMainRtl]}>
                  <Text style={[styles.rowDate, isRTL && styles.rtlText]}>
                    {formatISODateWeekdayDayMonth(item.session_date, language)}
                  </Text>
                  <Text style={[styles.rowTime, isRTL && styles.rtlText]}>
                    {formatSessionStartTime(item.start_time)}
                  </Text>
                  <Text style={[styles.rowCoach, isRTL && styles.rtlText]} numberOfLines={1}>
                    {item.coachName}
                  </Text>
                </View>
                <View style={[styles.countChip, full && styles.countChipFull]}>
                  <Text style={[styles.countChipTxt, full && styles.countChipTxtFull]}>
                    {item.count}/{item.max_participants}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </AppModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text, flex: 1 },
  close: { fontSize: 15, fontWeight: "700", color: theme.colors.textMuted },
  rtlText: { textAlign: "right", writingDirection: "rtl" },
  listContent: { paddingBottom: theme.spacing.lg },
  listHeader: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.sm, gap: 4 },
  participantName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  hint: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: theme.spacing.md,
    marginBottom: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowPressed: { opacity: 0.92, backgroundColor: theme.colors.surfaceElevated },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowMainRtl: { alignItems: "flex-end" },
  rowDate: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  rowTime: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  rowCoach: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  countChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  countChipFull: { borderColor: theme.colors.error, backgroundColor: theme.colors.errorBg },
  countChipTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted, fontVariant: ["tabular-nums"] },
  countChipTxtFull: { color: theme.colors.error },
  empty: { textAlign: "center", color: theme.colors.textMuted, fontWeight: "600", padding: theme.spacing.lg },
  center: { padding: theme.spacing.xl, alignItems: "center" },
  confirmBlock: { padding: theme.spacing.md, gap: theme.spacing.sm },
  confirmTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  confirmSession: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  confirmCoach: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  previewRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  previewRowRtl: { flexDirection: "row-reverse" },
  previewCell: {
    flex: 1,
    padding: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.backgroundAlt,
    gap: 4,
  },
  previewLbl: { fontSize: 11, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", letterSpacing: 0.4 },
  previewVal: { fontSize: 14, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  fullBlock: { marginTop: theme.spacing.sm, gap: 8 },
  fullTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  fullMsg: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 18, marginBottom: 4 },
  fullBtn: { marginTop: 0 },
  fullSecondary: {
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
  },
  fullSecondaryTxt: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  fullGhost: { paddingVertical: 8, alignItems: "center" },
  fullGhostTxt: { fontSize: 14, fontWeight: "700", color: theme.colors.textMuted },
  confirmActions: { marginTop: theme.spacing.sm, gap: 8 },
  backBtn: { alignItems: "center", paddingVertical: 8 },
  backBtnTxt: { fontSize: 14, fontWeight: "700", color: theme.colors.textMuted },
});
