import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { theme } from "../theme";
import type { SessionsWeekItem } from "./SessionsWeekCalendar";
import { formatSessionStartTime, getSessionTemporalPhase } from "../lib/sessionTime";
import { KickboxSessionBadge } from "./KickboxSessionBadge";
import { StatusChip } from "./StatusChip";
import { useI18n } from "../context/I18nContext";

type Props = {
  item: SessionsWeekItem;
  onPress: () => void;
  onDelete?: () => void;
  canDelete?: boolean;
  deleting?: boolean;
  isRTL?: boolean;
};

export function DaySessionSheetRow({ item, onPress, onDelete, canDelete, deleting, isRTL }: Props) {
  const { language } = useI18n();
  const phase = getSessionTemporalPhase(item.session_date, item.start_time, item.durationMinutes ?? 60);
  const accent = item.accentColor;
  const start = formatSessionStartTime(item.start_time);
  const c = item.signedUpCount ?? 0;
  const m = item.maxParticipants ?? 0;
  const showFill = m > 0 && item.signedUpCount !== undefined;
  const staffLabels = item.showStaffSessionLabels === true;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
    >
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      <View style={[styles.body, isRTL && styles.bodyRtl]}>
        <View style={[styles.timeCol, phase === "past" && styles.timeColPast]}>
          <Text style={[styles.time, phase === "past" && styles.timePast]}>{start}</Text>
          {phase === "live" ? (
            <View style={styles.livePill}>
              <Text style={styles.livePillTxt}>{language === "he" ? "עכשיו" : "Live"}</Text>
            </View>
          ) : phase === "past" ? (
            <View style={styles.endedPill}>
              <Text style={styles.endedPillTxt}>{language === "he" ? "הסתיים" : "Ended"}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.main}>
          {item.trainerName ? (
            <Text style={[styles.trainer, isRTL && styles.rtl]} numberOfLines={1}>
              {item.trainerName}
            </Text>
          ) : null}
          <View style={[styles.chips, isRTL && styles.chipsRtl]}>
            {showFill ? (
              <StatusChip label={`${c}/${m}`} tone={m > 0 && c >= m ? "danger" : "neutral"} />
            ) : null}
            {staffLabels && item.isHidden ? (
              <StatusChip label={language === "he" ? "מוסתר" : "Hidden"} tone="warning" />
            ) : null}
            {staffLabels && item.isOpenForRegistration === false ? (
              <StatusChip label={language === "he" ? "סגור" : "Closed"} tone="neutral" />
            ) : null}
            {item.isKickbox ? <KickboxSessionBadge compact isRTL={isRTL} /> : null}
          </View>
        </View>
        {!canDelete ? <Text style={styles.chevron}>{isRTL ? "‹" : "›"}</Text> : null}
      </View>
      {canDelete && onDelete ? (
        <Pressable
          onPress={onDelete}
          disabled={deleting}
          style={({ pressed }) => [styles.deleteHit, isRTL && styles.deleteHitRtl, pressed && { opacity: 0.65 }]}
          accessibilityRole="button"
          accessibilityLabel={language === "he" ? "מחיקה" : "Delete"}
          hitSlop={10}
        >
          {deleting ? (
            <ActivityIndicator size="small" color={theme.colors.textSoft} />
          ) : (
            <Text style={styles.deleteIcon}>×</Text>
          )}
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
    minHeight: 64,
  },
  cardPressed: { opacity: 0.92 },
  accent: {
    width: 3,
    alignSelf: "stretch",
  },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    paddingEnd: 36,
    gap: 12,
  },
  bodyRtl: { flexDirection: "row-reverse" },
  timeCol: {
    minWidth: 48,
    alignItems: "flex-start",
    gap: 4,
  },
  timeColPast: { opacity: 0.7 },
  time: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: -0.3,
    fontVariant: ["tabular-nums"],
  },
  timePast: { color: theme.colors.textMuted },
  livePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  livePillTxt: { color: theme.colors.success, fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  endedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  endedPillTxt: { color: theme.colors.textSoft, fontSize: 9, fontWeight: "800" },
  main: { flex: 1, minWidth: 0, gap: 6, justifyContent: "center" },
  trainer: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
    lineHeight: 20,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  chipsRtl: { flexDirection: "row-reverse" },
  rtl: { textAlign: "right" },
  chevron: {
    fontSize: 18,
    fontWeight: "300",
    color: theme.colors.textSoft,
  },
  deleteHit: {
    position: "absolute",
    top: 6,
    end: 6,
    width: 28,
    height: 28,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  deleteHitRtl: { end: undefined, start: 6 },
  deleteIcon: {
    fontSize: 18,
    fontWeight: "400",
    color: theme.colors.textSoft,
    lineHeight: 20,
    marginTop: -1,
  },
});
