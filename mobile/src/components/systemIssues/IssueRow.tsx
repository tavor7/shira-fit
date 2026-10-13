import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { AppText } from "../AppText";
import { StatusChip } from "../StatusChip";
import { Pill } from "../Pill";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import { fill, isRepeated, issueHeadline, relativeTime, severityKey, severityTone, sourceKey, statusKey, statusTone } from "../../lib/systemIssues/presentation";
import type { SystemIssueRow } from "../../lib/systemIssues/types";

type Props = { issue: SystemIssueRow; now: number; t: (k: string) => string; isRTL: boolean; onPress: () => void };

/** One issue in the list: readable headline first, chips for severity/status, compact meta line. */
export function IssueRow({ issue, now, t, isRTL, onPress }: Props) {
  const headline = issueHeadline(issue, t);
  const when = relativeTime(issue.last_seen, now, t);
  const occ = fill(pluralKey(t, "sysIssues.row.occurrences", issue.occurrence_count), { n: issue.occurrence_count });
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={fill(t("sysIssues.row.a11y"), { title: headline, severity: t(severityKey(issue.severity)), status: t(statusKey(issue.status)), when: fill(t("sysIssues.row.lastSeen"), { when }) })}
    >
      <AppText variant="title" isRTL={isRTL} numberOfLines={2}>
        {headline}
      </AppText>
      <View style={[styles.chips, rowFlipFor(isRTL) && styles.rowRtl]}>
        <StatusChip label={t(severityKey(issue.severity))} tone={severityTone(issue.severity)} />
        <StatusChip label={t(statusKey(issue.status))} tone={statusTone(issue.status)} />
        {isRepeated(issue) ? <Pill label={t("sysIssues.row.repeated")} tone="warning" /> : null}
        {issue.reopen_count > 0 ? <Pill label={fill(t("sysIssues.row.reopened"), { n: issue.reopen_count })} tone="neutral" /> : null}
      </View>
      <AppText variant="caption" muted isRTL={isRTL} numberOfLines={2}>
        {t(sourceKey(issue.source))} · {fill(t("sysIssues.row.lastSeen"), { when })} · {occ}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: theme.spacing.xs,
    minHeight: theme.controls.minTouch,
  },
  pressed: { opacity: 0.9 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs, alignItems: "center" },
  rowRtl: { flexDirection: "row-reverse" },
});
