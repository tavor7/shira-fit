import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { AppText } from "../AppText";
import { Skeleton } from "../Skeleton";
import { rowFlipFor } from "../../lib/layoutDirection";
import { fill, formatCount } from "../../lib/systemIssues/presentation";
import type { LanguageCode } from "../../i18n/translations";
import type { IssueSummary, StatusFilter } from "../../lib/systemIssues/types";

type Props = { summary: IssueSummary | null; loading: boolean; t: (k: string) => string; isRTL: boolean; lang: LanguageCode; onPickStatus: (s: StatusFilter) => void };

const CARDS: { key: keyof IssueSummary; labelKey: string; tone: string; filter?: StatusFilter }[] = [
  { key: "open", labelKey: "sysIssues.summary.open", tone: "#f87171", filter: "open" },
  { key: "acknowledged", labelKey: "sysIssues.summary.acknowledged", tone: theme.colors.info, filter: "acknowledged" },
  { key: "recent", labelKey: "sysIssues.summary.recent", tone: theme.colors.warning },
  { key: "reopened", labelKey: "sysIssues.summary.reopened", tone: theme.colors.warning },
  { key: "muted", labelKey: "sysIssues.summary.muted", tone: theme.colors.textMuted, filter: "muted" },
];

/** Dashboard counters (real values only; a card shows a skeleton while loading and an em dash if the count failed). */
export function SummaryCards({ summary, loading, t, isRTL, lang, onPickStatus }: Props) {
  return (
    <View style={[styles.grid, rowFlipFor(isRTL) && styles.rowRtl]}>
      {CARDS.map((c) => {
        const n = summary ? summary[c.key] : null;
        const label = t(c.labelKey);
        const body = (
          <>
            <AppText variant="label" muted isRTL={isRTL} numberOfLines={2}>
              {label}
            </AppText>
            {loading && n === null ? <Skeleton width={36} height={26} /> : <AppText variant="display" color={n ? c.tone : theme.colors.text}>{n === null ? "—" : formatCount(n, lang)}</AppText>}
          </>
        );
        const a11y = fill(t("sysIssues.summary.a11y"), { label, n: n === null ? "—" : formatCount(n, lang) });
        return c.filter ? (
          <Pressable key={c.key} onPress={() => onPickStatus(c.filter as StatusFilter)} style={({ pressed }) => [styles.card, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={a11y}>
            {body}
          </Pressable>
        ) : (
          <View key={c.key} style={styles.card} accessible accessibilityLabel={a11y}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
  rowRtl: { flexDirection: "row-reverse" },
  card: {
    flexGrow: 1,
    flexBasis: 96,
    minHeight: 76,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 4,
    justifyContent: "space-between",
  },
  pressed: { opacity: 0.9 },
});
