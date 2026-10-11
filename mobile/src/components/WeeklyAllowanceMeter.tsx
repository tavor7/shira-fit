import { StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { rowFlipFor } from "../lib/layoutDirection";

type Props = {
  /** Human tier label, already translated (e.g. from subscriptions.tierLabelKey). */
  title: string;
  used: number;
  limit: number;
  /** e.g. "2 of 3 used" — pre-translated by the caller (no plural rules live in this component). */
  usedLabel: string;
  /** e.g. "1 session left this week" or "Weekly allowance used" — pre-translated. */
  statusLabel: string;
  /** Only shown when exhausted, e.g. "Additional sessions can still be booked at the regular price." */
  noteLabel?: string;
  exhausted: boolean;
  isRTL?: boolean;
};

/** Compact, borderless weekly-usage indicator: label + count, a slim progress track, and a status
 * line. Deliberately not a table row or a gauge/pie chart — this is the one piece of UI an athlete
 * actually needs to read in a glance. */
export function WeeklyAllowanceMeter({ title, used, limit, usedLabel, statusLabel, noteLabel, exhausted, isRTL }: Props) {
  const pct = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;

  return (
    <View style={styles.wrap}>
      <View style={[styles.headerRow, rowFlipFor(isRTL) && styles.headerRowRtl]}>
        <AppText variant="title" isRTL={isRTL} style={styles.title} numberOfLines={1}>
          {title}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL}>
          {usedLabel}
        </AppText>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${pct * 100}%`, backgroundColor: exhausted ? theme.colors.textSoft : theme.colors.success },
            isRTL ? styles.fillRtl : styles.fillLtr,
          ]}
        />
      </View>
      <AppText variant="caption" isRTL={isRTL} style={[styles.status, exhausted && styles.statusMuted]}>
        {statusLabel}
      </AppText>
      {noteLabel ? (
        <AppText variant="caption" muted isRTL={isRTL} style={styles.note}>
          {noteLabel}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: theme.spacing.sm },
  headerRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: theme.spacing.sm },
  headerRowRtl: { flexDirection: "row-reverse" },
  title: { flexShrink: 1 },
  track: {
    marginTop: 8,
    height: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
    position: "relative",
  },
  fill: { position: "absolute", top: 0, bottom: 0, borderRadius: theme.radius.full },
  fillLtr: { left: 0 },
  fillRtl: { right: 0 },
  status: { marginTop: 8, fontWeight: "700", color: theme.colors.text },
  statusMuted: { color: theme.colors.textSoft, fontWeight: "600" },
  note: { marginTop: 2 },
});
