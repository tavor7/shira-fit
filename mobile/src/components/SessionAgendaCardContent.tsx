import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import type { SessionsWeekItem } from "./SessionsWeekCalendar";

type Props = {
  item: SessionsWeekItem;
  /** Narrow column (week grid); slightly smaller type */
  compact?: boolean;
};

export function SessionAgendaCardContent({ item, compact }: Props) {
  const accent = item.accentColor;
  const showFill = item.signedUpCount !== undefined && item.maxParticipants !== undefined;
  const staffLabels = item.showStaffSessionLabels === true;

  return (
    <View style={[styles.inner, accent ? { borderLeftWidth: 3, borderLeftColor: accent, paddingLeft: 8 } : null]}>
      <Text style={[styles.time, compact && styles.timeCompact]}>{item.timeLabel ?? item.start_time}</Text>
      {item.trainerName ? (
        <Text style={[styles.trainer, compact && styles.trainerCompact]} numberOfLines={2}>
          {item.trainerName}
        </Text>
      ) : null}
      {showFill ? (
        <Text style={[styles.fill, compact && styles.fillCompact]}>
          {item.signedUpCount} / {item.maxParticipants}
        </Text>
      ) : null}
      {staffLabels ? (
        <View style={styles.tags}>
          <View style={[styles.tag, item.isHidden ? styles.tagHidden : styles.tagListed]}>
            <Text style={[styles.tagTxt, item.isHidden ? styles.tagTxtHidden : styles.tagTxtListed]}>
              {item.isHidden ? "Hidden" : "Visible"}
            </Text>
          </View>
          <View style={[styles.tag, item.isOpenForRegistration ? styles.tagOpen : styles.tagClosed]}>
            <Text style={[styles.tagTxt, item.isOpenForRegistration ? styles.tagTxtOpen : styles.tagTxtClosed]}>
              {item.isOpenForRegistration ? "Open" : "Closed"}
            </Text>
          </View>
        </View>
      ) : item.subtitle ? (
        <Text style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={2}>
          {item.subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inner: { paddingVertical: 2 },
  time: { fontWeight: "800", color: theme.colors.cta, fontSize: 13, letterSpacing: 0.2 },
  timeCompact: { fontSize: 12 },
  trainer: { marginTop: 4, color: theme.colors.text, fontSize: 12, fontWeight: "600", lineHeight: 15 },
  trainerCompact: { fontSize: 11, marginTop: 3 },
  fill: { marginTop: 6, fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, letterSpacing: 0.5 },
  fillCompact: { marginTop: 4, fontSize: 11 },
  subtitle: { marginTop: 4, color: theme.colors.textMuted, fontSize: 11, lineHeight: 14 },
  subtitleCompact: { fontSize: 10, marginTop: 3 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.full, borderWidth: 1 },
  tagHidden: { backgroundColor: "rgba(245,158,11,0.12)", borderColor: "rgba(245,158,11,0.35)" },
  tagListed: { backgroundColor: "rgba(148,163,184,0.12)", borderColor: "rgba(148,163,184,0.3)" },
  tagOpen: { backgroundColor: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.35)" },
  tagClosed: { backgroundColor: "rgba(148,163,184,0.1)", borderColor: "rgba(148,163,184,0.28)" },
  tagTxt: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase" },
  tagTxtHidden: { color: "#FBBF24" },
  tagTxtListed: { color: theme.colors.textMuted },
  tagTxtOpen: { color: theme.colors.success },
  tagTxtClosed: { color: theme.colors.textSoft },
});
