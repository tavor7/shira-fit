import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { PricingIssue, PricingIssueKind, PricingIssueParams, PricingIssueSection } from "../lib/pricingIssues";
import { AnimatedOptionExpand } from "./AnimatedOptionExpand";

type Props = {
  issues: PricingIssue[];
  onFix: (issue: PricingIssue) => void;
  isRTL?: boolean;
};

const SECTION_KEYS: Record<PricingIssueSection, string> = {
  standard: "pricing.issuesSectionStandard",
  athlete: "pricing.issuesSectionAthlete",
  kickbox: "pricing.issuesSectionKickbox",
  coach: "pricing.issuesSectionCoach",
};

const KIND_TITLE_KEYS: Record<PricingIssueKind, string> = {
  overlap: "pricing.issueOverlapTitle",
  gap_today: "pricing.issueGapTodayTitle",
  gap_between: "pricing.issueGapBetweenTitle",
  gap_future: "pricing.issueGapFutureTitle",
  section_empty: "pricing.issueSectionEmptyTitle",
  section_no_active: "pricing.issueSectionInactiveTitle",
  session_missing_rate: "pricing.issueSessionMissingTitle",
  athlete_billing_gap: "pricing.issueAthleteBillingTitle",
  coach_session_missing: "pricing.issueCoachSessionTitle",
};

const KIND_DETAIL_KEYS: Record<PricingIssueKind, string> = {
  overlap: "pricing.issueOverlapDetail",
  gap_today: "pricing.issueGapTodayDetail",
  gap_between: "pricing.issueGapBetweenDetail",
  gap_future: "pricing.issueGapFutureDetail",
  section_empty: "pricing.issueSectionEmptyDetail",
  section_no_active: "pricing.issueSectionInactiveDetail",
  session_missing_rate: "pricing.issueSessionMissingDetail",
  athlete_billing_gap: "pricing.issueAthleteBillingDetail",
  coach_session_missing: "pricing.issueCoachSessionDetail",
};

function interpolate(template: string, params: PricingIssueParams): string {
  let s = template;
  const entries: (keyof PricingIssueParams)[] = [
    "context",
    "rangeA",
    "rangeB",
    "gapRange",
    "date",
    "capacity",
    "registered",
    "athleteName",
    "rateType",
  ];
  for (const key of entries) {
    const val = params[key];
    if (val != null && val !== "") {
      s = s.replace(new RegExp(`\\{${key}\\}`, "g"), val);
    }
  }
  return s;
}

function issueCopy(issue: PricingIssue, t: (key: string) => string): { title: string; detail: string } {
  const p: PricingIssueParams = { ...issue.params };
  if (issue.kind === "session_missing_rate") {
    p.rateType =
      issue.section === "kickbox"
        ? t("pricing.issuesSectionKickbox")
        : t("pricing.issuesSectionStandard");
  }
  return {
    title: interpolate(t(KIND_TITLE_KEYS[issue.kind]), p),
    detail: interpolate(t(KIND_DETAIL_KEYS[issue.kind]), p),
  };
}

export function PricingIssuesPanel({ issues, onFix, isRTL }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const errorCount = useMemo(() => issues.filter((i) => i.severity === "error").length, [issues]);
  const warnCount = issues.length - errorCount;

  if (issues.length === 0) return null;

  const accent = errorCount > 0 ? theme.colors.error : "#f59e0b";

  return (
    <View style={[styles.wrap, { borderLeftColor: accent }]}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => [styles.header, isRTL && styles.headerRtl, pressed && { opacity: 0.92 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t("pricing.issuesBannerA11y").replace("{n}", String(issues.length))}
      >
        <View style={[styles.badge, { backgroundColor: accent }]}>
          <Text style={styles.badgeTxt}>{issues.length}</Text>
        </View>
        <View style={styles.headerTextCol}>
          <Text style={[styles.headerTitle, isRTL && styles.rtl]}>
            {t("pricing.issuesBannerTitle").replace("{n}", String(issues.length))}
          </Text>
          <Text style={[styles.headerSub, isRTL && styles.rtl]} numberOfLines={2}>
            {errorCount > 0
              ? t("pricing.issuesBannerSubErrors").replace("{n}", String(errorCount))
              : warnCount > 0
                ? t("pricing.issuesBannerSubWarnings").replace("{n}", String(warnCount))
                : ""}
          </Text>
        </View>
        <Text style={styles.chevron}>{expanded ? "▴" : "▾"}</Text>
      </Pressable>

      <AnimatedOptionExpand open={expanded}>
        <View style={styles.list}>
          {issues.map((issue, idx) => {
            const copy = issueCopy(issue, t);
            return (
              <View
                key={issue.id}
                style={[styles.row, idx < issues.length - 1 && styles.rowBorder, isRTL && styles.rowRtl]}
              >
                <View style={styles.rowBody}>
                  <View style={[styles.rowMeta, isRTL && styles.rowMetaRtl]}>
                    <Text style={[styles.sectionTag, isRTL && styles.rtl]}>{t(SECTION_KEYS[issue.section])}</Text>
                    <View
                      style={[
                        styles.severityDot,
                        issue.severity === "error" ? styles.severityError : styles.severityWarn,
                      ]}
                    />
                  </View>
                  <Text style={[styles.rowTitle, isRTL && styles.rtl]}>{copy.title}</Text>
                  <Text style={[styles.rowDetail, isRTL && styles.rtl]}>{copy.detail}</Text>
                </View>
                {issue.fix ? (
                  <Pressable
                    onPress={() => onFix(issue)}
                    style={({ pressed }) => [styles.fixBtn, pressed && { opacity: 0.88 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t("pricing.issuesFix")}
                  >
                    <Text style={styles.fixBtnTxt}>{t("pricing.issuesFix")}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      </AnimatedOptionExpand>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: theme.spacing.md,
    borderLeftWidth: 4,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
  },
  headerRtl: { flexDirection: "row-reverse" },
  badge: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeTxt: { color: "#fff", fontSize: 13, fontWeight: "900" },
  headerTextCol: { flex: 1, minWidth: 0, gap: 2 },
  headerTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  headerSub: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 17 },
  chevron: { fontSize: 14, fontWeight: "800", color: theme.colors.textMuted },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderMuted },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.borderMuted },
  rowBody: { flex: 1, minWidth: 0, gap: 5 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowMetaRtl: { flexDirection: "row-reverse" },
  sectionTag: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  severityDot: { width: 6, height: 6, borderRadius: 3 },
  severityError: { backgroundColor: theme.colors.error },
  severityWarn: { backgroundColor: "#f59e0b" },
  rowTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text, lineHeight: 19 },
  rowDetail: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 18 },
  fixBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
    alignSelf: "flex-start",
    marginTop: 2,
  },
  fixBtnTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.ctaText },
  rtl: { textAlign: "right" },
});
