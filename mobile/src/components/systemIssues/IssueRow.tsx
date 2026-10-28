import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { AppText } from "../AppText";
import { StatusChip } from "../StatusChip";
import { Pill } from "../Pill";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import { fill, formatCount, isRepeated, issueHeadline, relativeTime, severityKey, severityTone, sourceKey, statusKey, statusTone } from "../../lib/systemIssues/presentation";
import type { EnvironmentFilter, SystemIssueRow } from "../../lib/systemIssues/types";
import type { LanguageCode } from "../../i18n/translations";

type Props = {
  issue: SystemIssueRow;
  now: number;
  t: (k: string) => string;
  isRTL: boolean;
  lang: LanguageCode;
  onPress: () => void;
  /** Which environment's count/last-seen to show. Defaults to "all" (the row's own global fields). */
  environment?: EnvironmentFilter;
};

/** One issue in the list: readable headline first, chips for severity/status, compact meta line. */
export function IssueRow({ issue, now, t, isRTL, lang, onPress, environment = "all" }: Props) {
  const headline = issueHeadline(issue, t);
  // Under a specific environment filter, show that environment's own last-seen/count, not the global ones --
  // a mixed-environment issue's global last_seen could be a more recent occurrence in the OTHER environment.
  const scopedLastSeen = environment === "production" ? issue.prod_last_seen : environment === "development" ? issue.dev_last_seen : issue.last_seen;
  const scopedCount = environment === "production" ? issue.prod_occurrence_count : environment === "development" ? issue.dev_occurrence_count : issue.occurrence_count;
  const when = relativeTime(scopedLastSeen ?? issue.last_seen, now, t);
  const occCount = scopedCount ?? 0;
  const occ = fill(pluralKey(t, "sysIssues.row.occurrences", occCount), { n: formatCount(occCount, lang) });
  const envIncomplete = environment !== "all" && !issue.env_history_complete;
  return (
    <Pressable
      onPress={onPress}
      testID={`issue-row-${issue.id}`}
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
        {issue.reopen_count > 0 ? <Pill label={fill(t("sysIssues.row.reopened"), { n: formatCount(issue.reopen_count, lang) })} tone="neutral" /> : null}
      </View>
      <AppText variant="caption" muted isRTL={isRTL} numberOfLines={2}>
        {t(sourceKey(issue.source))} · {fill(t("sysIssues.row.lastSeen"), { when })} · {envIncomplete ? `${occ} ${t("sysIssues.row.envIncomplete")}` : occ}
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
