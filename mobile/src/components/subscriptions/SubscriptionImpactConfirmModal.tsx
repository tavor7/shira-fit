import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { tierLabelKey, type SubscriptionImpact } from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import {
  fetchImpactSessionDetails,
  groupImpactByDate,
  impactItemKey,
  type ImpactSessionDetail,
} from "../../lib/subscriptionImpactDetails";

const EMPTY_DETAILS = new Map<string, ImpactSessionDetail>();

export type ImpactConfirmAction = "edit" | "freeze" | "stop";

type Props = {
  visible: boolean;
  action: ImpactConfirmAction;
  impact: SubscriptionImpact | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Single shared impact-preview/confirm dialog, reused for edit/freeze/stop — one source of truth
 * in the frontend for the identical conceptual moment (some currently-covered registrations would
 * flip to paid-extra). Never computes the impact itself: `impact` always comes straight from the
 * backend's subscription_compute_impact (via edit_subscription_version / freeze_subscription /
 * stop_subscription's own preview response) and confirming re-calls the SAME RPC with
 * p_confirmed=true, so the server always re-verifies before applying — this dialog only presents
 * what the server already decided.
 */
export function SubscriptionImpactConfirmModal({ visible, action, impact, busy, onCancel, onConfirm }: Props) {
  const { t, language, isRTL } = useI18n();

  const titleKey =
    action === "edit" ? "subscriptions.impact.titleEdit" : action === "freeze" ? "subscriptions.impact.titleFreeze" : "subscriptions.impact.titleStop";

  const count = impact?.count ?? 0;

  // Phase 5 / S: each affected session with its time and coach, so two sessions on one day are distinct.
  // Read-only lookup with the manager's own access; on failure the rows keep the date grouping only.
  const [fetched, setFetched] = useState<{ for: SubscriptionImpact; map: Map<string, ImpactSessionDetail> } | null>(null);
  const details = fetched && fetched.for === impact ? fetched.map : EMPTY_DETAILS;
  useEffect(() => {
    if (!visible || !impact?.items?.length) return;
    let cancelled = false;
    fetchImpactSessionDetails(impact.items)
      .then((map) => {
        if (!cancelled) setFetched({ for: impact, map });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, impact]);

  // Chronological, grouped by date (the RPC returns coverage order).
  const timeOf = (it: { registration_id: string | null; manual_participant_id: string | null }) => details.get(impactItemKey(it))?.time ?? null;
  const all = groupImpactByDate(impact?.items ?? [], timeOf).flatMap((g) => g.items);
  // At most 8 rows plus the "+N more" line: short enough to show in full. A fixed-height scroll area hid
  // rows 7–8 and the "+N more" line with nothing indicating more content.
  const shown = all.slice(0, 8);
  const remaining = all.length - shown.length;
  const groups = groupImpactByDate(shown, timeOf);
  const dayCount = (date: string) => all.filter((it) => it.session_date === date).length;

  return (
    // scrollContent="short": on a very short window (400% zoom, landscape phone) the explanation body shrank to 0px above the pinned actions; the whole card scrolls instead, so the full billing impact can be read before confirming.
    <AppModal visible={visible} onClose={onCancel} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("subscriptions.impact.cancel")}>
      <View style={styles.card}>
        {/* Content scrolls when the window is short (320×568); the actions below stay visible. */}
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
          {t(titleKey)}
        </Text>
        <Text style={[styles.message, isRTL && styles.rtl]}>
          {pluralKey(t, "subscriptions.impact.message", count).replace("{n}", String(count))}
        </Text>

        {shown.length > 0 ? (
          <View style={styles.detailBox}>
            <Text style={[styles.detailHeader, isRTL && styles.rtl]}>{t("subscriptions.impact.detailHeader")}</Text>
            <View style={styles.detailList}>
              {groups.map((g) => (
                <View key={g.date} style={styles.dayGroup}>
                  <View style={[styles.dayHead, rowFlipFor(isRTL) && styles.detailRowRtl]}>
                    <Text style={[styles.detailDate, isRTL && styles.rtl]}>{formatISODateFull(g.date, language)}</Text>
                    {dayCount(g.date) > 1 ? <Text style={styles.dayCount}>{dayCount(g.date)}</Text> : null}
                  </View>
                  {g.items.map((item, idx) => {
                    const d = details.get(impactItemKey(item));
                    const when = [d?.time, d?.coach].filter(Boolean).join(" · ");
                    return (
                      <View
                        key={`${item.registration_id ?? item.manual_participant_id ?? idx}`}
                        style={[styles.detailRow, rowFlipFor(isRTL) && styles.detailRowRtl]}
                      >
                        <Text style={[styles.detailWhen, isRTL && styles.rtl]} numberOfLines={1}>
                          {when || " "}
                        </Text>
                        <Text style={[styles.detailTier, isRTL && styles.rtl]}>{t(tierLabelKey(item.tier))}</Text>
                      </View>
                    );
                  })}
                </View>
              ))}
              {remaining > 0 ? (
                <Text style={[styles.moreLine, isRTL && styles.rtl]}>
                  {t("subscriptions.impact.moreItems").replace("{n}", String(remaining))}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        </ScrollView>

        <View style={[styles.actions, rowFlipFor(isRTL) && styles.actionsRtl]}>
          <PrimaryButton label={t("subscriptions.impact.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          <PrimaryButton
            label={t("subscriptions.impact.confirm")}
            onPress={onConfirm}
            loading={busy}
            variant="danger"
            style={styles.btn}
          />
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { padding: theme.spacing.lg, flexShrink: 1, minHeight: 0 },
  body: { flexShrink: 1 },
  bodyContent: { flexGrow: 0 },
  title: { ...theme.typography.headline, color: theme.colors.text, marginBottom: theme.spacing.sm },
  message: { fontSize: 15, fontWeight: "500", lineHeight: 22, color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  detailBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  detailHeader: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", marginBottom: 6 },
  detailList: {},
  dayGroup: { paddingVertical: 4 },
  dayHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 },
  dayCount: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: "hidden",
  },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4, gap: 8 },
  detailWhen: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: "600", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  detailRowRtl: { flexDirection: "row-reverse" },
  detailDate: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  detailTier: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
  moreLine: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginTop: 4 },
  // Wraps on very narrow windows (two 120px buttons do not fit a 320px dialog), stacking full-width instead of overflowing.
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, justifyContent: "flex-end" },
  actionsRtl: { flexDirection: "row-reverse" },
  btn: { flexGrow: 1, flexShrink: 1, minWidth: 120 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
