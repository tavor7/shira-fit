import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { AppText } from "../components/AppText";
import { StatusChip } from "../components/StatusChip";
import { Pill } from "../components/Pill";
import { PrimaryButton } from "../components/PrimaryButton";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { rowFlipFor } from "../lib/layoutDirection";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import { displayLtr } from "../lib/displayFormat";
import { pluralKey } from "../lib/pluralKey";
import { useRefetchOnResume } from "../hooks/useRefetchOnResume";
import {
  acknowledgeIssue,
  fetchIssueDetail,
  isIssueId,
  muteIssue,
  reopenIssue,
  resolveIssue,
  unmuteIssue,
  type IssueDetail,
} from "../lib/systemIssues/queries";
import {
  actionErrorKey,
  activityBars,
  allowedActions,
  fill,
  formatCount,
  isRepeated,
  issueExplanation,
  issueHeadline,
  knownKind,
  knownReason,
  relativeTime,
  safeContext,
  safeText,
  severityKey,
  severityTone,
  sourceKey,
  statusKey,
  statusTone,
  transitionKindKey,
  transitionReasonKey,
  type IssueAction,
} from "../lib/systemIssues/presentation";
import type { ActionResult } from "../lib/systemIssues/types";

type LoadState = "loading" | "ready" | "error";

/** Manager issue detail: readable summary, actions the server supports, bounded events/history, technical details collapsed. */
export default function ManagerSystemIssueDetailScreen() {
  const { t, isRTL, language } = useI18n();
  const { showAlert, showOk } = useAppAlert();
  const content = useScreenContentStyle("standard");
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const focused = useRef(false);
  const markFresh = useRef<() => void>(() => undefined);
  const req = useRef(0);

  const load = useCallback(async () => {
    if (!isIssueId(id)) {
      // not an issue id at all: no request, same screen as a missing issue
      setDetail({ issue: null, events: [], transitions: [], buckets: [], failed: [] });
      setState("ready");
      return;
    }
    const mine = ++req.current;
    try {
      const d = await fetchIssueDetail(supabase, id);
      if (mine !== req.current) return;
      setDetail(d);
      setNow(Date.now());
      markFresh.current();
      setState("ready");
    } catch {
      if (mine !== req.current) return;
      setState((s) => (s === "ready" ? s : "error"));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
      };
    }, [load])
  );
  const markFreshFn = useRefetchOnResume(() => void load(), () => focused.current && !busyRef.current);
  useEffect(() => {
    markFresh.current = markFreshFn;
  }, [markFreshFn]);

  async function run(fn: () => Promise<ActionResult>) {
    if (busyRef.current) return; // never submit twice
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) showOk(t("sysIssues.title"), t("sysIssues.action.done"));
      else showOk(t("common.error"), t(actionErrorKey(r.error)));
    } catch {
      showOk(t("common.error"), t("sysIssues.err.generic"));
    } finally {
      busyRef.current = false;
      setBusy(false);
      await load(); // focused refresh of this issue only
    }
  }

  function confirmAction(action: IssueAction) {
    const issue = detail?.issue;
    if (!issue) return;
    const cancel = { label: t("common.cancel"), variant: "secondary" as const, onPress: () => {} };
    if (action === "acknowledge") {
      showAlert({ dismissOnly: true, title: t("sysIssues.confirm.ack.title"), message: t("sysIssues.confirm.ack.body"), actions: [cancel, { label: t("sysIssues.action.acknowledge"), variant: "primary", onPress: () => void run(() => acknowledgeIssue(supabase, issue.id)) }] });
    } else if (action === "resolve") {
      showAlert({
        dismissOnly: true,
        title: t("sysIssues.confirm.resolve.title"),
        message: t("sysIssues.confirm.resolve.body"),
        actions: [
          { label: t("sysIssues.confirm.resolve.fixed"), variant: "primary", onPress: () => void run(() => resolveIssue(supabase, issue.id, "manual_fixed", issue.last_seen)) },
          { label: t("sysIssues.confirm.resolve.expected"), variant: "secondary", onPress: () => void run(() => resolveIssue(supabase, issue.id, "manual_expected", issue.last_seen)) },
          cancel,
        ],
      });
    } else if (action === "mute") {
      const mute = (days: number | null) => () => void run(() => muteIssue(supabase, issue.id, days === null ? null : new Date(Date.now() + days * 86_400_000)));
      showAlert({
        dismissOnly: true,
        title: t("sysIssues.confirm.mute.title"),
        message: t("sysIssues.confirm.mute.body"),
        actions: [
          { label: t("sysIssues.confirm.mute.day"), variant: "secondary", onPress: mute(1) },
          { label: t("sysIssues.confirm.mute.week"), variant: "secondary", onPress: mute(7) },
          { label: t("sysIssues.confirm.mute.month"), variant: "secondary", onPress: mute(30) },
          { label: t("sysIssues.confirm.mute.forever"), variant: "secondary", onPress: mute(null) },
          cancel,
        ],
      });
    } else if (action === "unmute") {
      showAlert({ dismissOnly: true, title: t("sysIssues.confirm.unmute.title"), message: t("sysIssues.confirm.unmute.body"), actions: [cancel, { label: t("sysIssues.action.unmute"), variant: "primary", onPress: () => void run(() => unmuteIssue(supabase, issue.id)) }] });
    } else {
      showAlert({ dismissOnly: true, title: t("sysIssues.confirm.reopen.title"), message: t("sysIssues.confirm.reopen.body"), actions: [cancel, { label: t("sysIssues.action.reopen"), variant: "primary", onPress: () => void run(() => reopenIssue(supabase, issue.id)) }] });
    }
  }

  if (state === "loading" && !detail) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, content]}>
        <Skeleton width="70%" height={24} />
        <Skeleton width="40%" height={18} />
        <Skeleton width="100%" height={90} />
        <Skeleton width="100%" height={140} />
      </ScrollView>
    );
  }
  if (state === "error" && !detail) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, content]}>
        <ErrorState title={t("sysIssues.detail.error.title")} body={t("sysIssues.list.error.body")} actionLabel={t("sysIssues.list.retry")} onAction={() => void load()} isRTL={isRTL} />
      </ScrollView>
    );
  }
  const issue = detail?.issue;
  if (!issue) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, content]}>
        <EmptyState tone="notFound" title={t("sysIssues.detail.notFound.title")} body={t("sysIssues.detail.notFound.body")} actionLabel={t("sysIssues.detail.back")} onAction={() => router.replace("/(app)/manager/system-issues" as never)} isRTL={isRTL} />
      </ScrollView>
    );
  }

  const bars = activityBars(detail?.buckets ?? [], now);
  const maxBar = Math.max(1, ...bars);
  const hasActivity = bars.some((b) => b > 0);
  const actions = allowedActions(issue.status);
  const flip = rowFlipFor(isRTL);
  // The 24-hour activity strip keeps time running left to right (oldest hour first) in both languages, like any chart axis.
  const mutedLine = issue.status === "muted" ? (issue.muted_until ? fill(t("sysIssues.detail.mutedUntil"), { date: formatDateTimeForDisplay(issue.muted_until, language) }) : t("sysIssues.detail.mutedForever")) : null;
  const occ = fill(pluralKey(t, "sysIssues.row.occurrences", issue.occurrence_count), { n: formatCount(issue.occurrence_count, language) });
  const failed = detail?.failed ?? [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, content]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} tintColor={theme.colors.textMuted} />}
    >
      <View style={styles.card}>
        <AppText variant="headline" isRTL={isRTL}>
          {issueHeadline(issue, t)}
        </AppText>
        <View style={[styles.chips, flip && styles.rowRtl]}>
          <StatusChip label={t(severityKey(issue.severity))} tone={severityTone(issue.severity)} />
          <StatusChip label={t(statusKey(issue.status))} tone={statusTone(issue.status)} />
          {isRepeated(issue) ? <Pill label={t("sysIssues.row.repeated")} tone="warning" /> : null}
          {issue.reopen_count > 0 ? <Pill label={fill(t("sysIssues.row.reopened"), { n: formatCount(issue.reopen_count, language) })} tone="neutral" /> : null}
        </View>
        {mutedLine ? (
          <AppText variant="caption" muted isRTL={isRTL}>
            {mutedLine}
          </AppText>
        ) : null}
        <AppText variant="caption" muted isRTL={isRTL}>
          {t(sourceKey(issue.source))} · {occ}
        </AppText>
      </View>

      {actions.length > 0 ? (
        <View style={[styles.actions, flip && styles.rowRtl]}>
          {actions.map((a, i) => (
            <PrimaryButton
              key={a}
              label={t(`sysIssues.action.${a}`)}
              loadingLabel={t("sysIssues.action.working")}
              loading={busy}
              disabled={busy}
              onPress={() => confirmAction(a)}
              variant={i === 0 ? "cta" : "ghost"}
              size="compact"
              style={styles.actionBtn}
            />
          ))}
        </View>
      ) : null}

      <Section title={t("sysIssues.detail.whatHappened")} isRTL={isRTL}>
        <AppText variant="body" isRTL={isRTL}>
          {issueExplanation(issue, t)}
        </AppText>
      </Section>

      <Section title={t("sysIssues.detail.facts")} isRTL={isRTL}>
        <Fact label={t("sysIssues.detail.firstSeen")} value={formatDateTimeForDisplay(issue.first_seen, language)} sub={relativeTime(issue.first_seen, now, t)} isRTL={isRTL} />
        <Fact label={t("sysIssues.detail.lastSeen")} value={formatDateTimeForDisplay(issue.last_seen, language)} sub={relativeTime(issue.last_seen, now, t)} isRTL={isRTL} />
        <Fact label={t("sysIssues.detail.occurrences")} value={formatCount(issue.occurrence_count, language)} isRTL={isRTL} />
        <Fact label={t("sysIssues.detail.reopens")} value={formatCount(issue.reopen_count, language)} sub={issue.reopened_at ? relativeTime(issue.reopened_at, now, t) : undefined} isRTL={isRTL} />
        <Fact label={t("sysIssues.detail.source")} value={t(sourceKey(issue.source))} isRTL={isRTL} />
      </Section>

      <Section title={t("sysIssues.detail.activity")} isRTL={isRTL}>
        {failed.includes("buckets") ? (
          <SectionError t={t} isRTL={isRTL} onRetry={() => void load()} />
        ) : hasActivity ? (
          <View style={styles.bars} accessible accessibilityLabel={`${t("sysIssues.detail.activity")}: ${bars.reduce((a, b) => a + b, 0)}`}>
            {bars.map((b, i) => (
              <View key={i} style={styles.barSlot}>
                <View style={[styles.bar, { height: Math.max(b > 0 ? 4 : 2, Math.round((b / maxBar) * 44)), opacity: b > 0 ? 1 : 0.25 }]} />
              </View>
            ))}
          </View>
        ) : (
          <AppText variant="secondary" muted isRTL={isRTL}>
            {t("sysIssues.detail.activityEmpty")}
          </AppText>
        )}
      </Section>

      <Section title={t("sysIssues.detail.events")} isRTL={isRTL}>
        {failed.includes("events") ? (
          <SectionError t={t} isRTL={isRTL} onRetry={() => void load()} />
        ) : detail && detail.events.length > 0 ? (
          <>
            {detail.events.slice(0, 8).map((e) => (
              <View key={e.id} style={styles.item}>
                <View style={[styles.chips, flip && styles.rowRtl]}>
                  <StatusChip label={t(severityKey(e.severity))} tone={severityTone(e.severity)} />
                  <AppText variant="caption" muted>
                    {formatDateTimeForDisplay(e.occurred_at, language)}
                  </AppText>
                </View>
                {e.message ? (
                  <AppText variant="secondary" isRTL={isRTL} numberOfLines={3}>
                    {displayLtr(safeText(e.message, 200))}
                  </AppText>
                ) : null}
              </View>
            ))}
            <AppText variant="helper" soft isRTL={isRTL}>
              {t("sysIssues.detail.eventsNote")}
            </AppText>
          </>
        ) : (
          <AppText variant="secondary" muted isRTL={isRTL}>
            {t("sysIssues.detail.eventsEmpty")}
          </AppText>
        )}
      </Section>

      <Section title={t("sysIssues.detail.history")} isRTL={isRTL}>
        {failed.includes("transitions") ? (
          <SectionError t={t} isRTL={isRTL} onRetry={() => void load()} />
        ) : detail && detail.transitions.length > 0 ? (
          detail.transitions.map((tr) => (
            <View key={String(tr.id)} style={styles.item}>
              <AppText variant="title" isRTL={isRTL}>
                {knownKind(tr.kind) ? t(transitionKindKey(tr.kind)) : t("sysIssues.kind.other")}
              </AppText>
              <AppText variant="caption" muted isRTL={isRTL}>
                {formatDateTimeForDisplay(tr.at, language)}
                {knownReason(tr.reason) ? ` · ${t(transitionReasonKey(tr.reason))}` : ""}
              </AppText>
            </View>
          ))
        ) : (
          <AppText variant="secondary" muted isRTL={isRTL}>
            {t("sysIssues.detail.historyEmpty")}
          </AppText>
        )}
      </Section>

      <Pressable
        onPress={() => setShowAdvanced((s) => !s)}
        style={({ pressed }) => [styles.advToggle, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityLabel={showAdvanced ? t("sysIssues.detail.advancedHide") : t("sysIssues.detail.advanced")}
        accessibilityState={{ expanded: showAdvanced }}
      >
        <AppText variant="title" isRTL={isRTL}>
          {showAdvanced ? t("sysIssues.detail.advancedHide") : t("sysIssues.detail.advanced")}
        </AppText>
      </Pressable>
      {showAdvanced ? (
        <View style={styles.card}>
          <AppText variant="helper" soft isRTL={isRTL}>
            {t("sysIssues.detail.advancedNote")}
          </AppText>
          <Tech label={t("sysIssues.adv.operation")} value={issue.operation} />
          <Tech label={t("sysIssues.adv.operationLabel")} value={issue.operation_label} />
          <Tech label={t("sysIssues.adv.errorClass")} value={issue.error_class} />
          <Tech label={t("sysIssues.adv.errorCode")} value={issue.error_code} />
          <Tech label={t("sysIssues.adv.subsystem")} value={issue.subsystem} />
          <Tech label={t("sysIssues.adv.sourceRaw")} value={issue.source} />
          <Tech label={t("sysIssues.adv.envComplete")} value={t(issue.env_history_complete ? "sysIssues.adv.envComplete.exact" : "sysIssues.adv.envComplete.approximate")} />
          <Tech label={t("sysIssues.adv.prodOccurrences")} value={issue.prod_occurrence_count != null ? formatCount(issue.prod_occurrence_count, language) : null} />
          <Tech label={t("sysIssues.adv.prodLastSeen")} value={issue.prod_last_seen ? formatDateTimeForDisplay(issue.prod_last_seen, language) : null} />
          <Tech label={t("sysIssues.adv.devOccurrences")} value={issue.dev_occurrence_count != null ? formatCount(issue.dev_occurrence_count, language) : null} />
          <Tech label={t("sysIssues.adv.devLastSeen")} value={issue.dev_last_seen ? formatDateTimeForDisplay(issue.dev_last_seen, language) : null} />
          <Tech label={t("sysIssues.adv.impact")} value={issue.impact} />
          <Tech label={t("sysIssues.adv.baseSeverity")} value={issue.base_severity} />
          <Tech label={t("sysIssues.adv.firstVersion")} value={issue.first_seen_version} />
          <Tech label={t("sysIssues.adv.lastVersion")} value={issue.last_seen_version} />
          <Tech label={t("sysIssues.adv.regressed")} value={issue.regressed_in_version} />
          {detail && detail.events.length > 0 ? (
            <>
              <AppText variant="label" muted style={styles.advHead}>
                {t("sysIssues.detail.events")}
              </AppText>
              {detail.events.slice(0, 5).map((e) => {
                const ctx = safeContext(e.context);
                return (
                  <View key={e.id} style={styles.item}>
                    <Tech label={t("sysIssues.adv.message")} value={e.message ? displayLtr(safeText(e.message, 200)) : null} />
                    <Tech label={t("sysIssues.adv.platform")} value={[e.platform, e.env, e.app_version, e.build].filter(Boolean).join(" · ") || null} />
                    <Tech label={t("sysIssues.adv.role")} value={e.user_role} />
                    <Tech label={t("sysIssues.adv.context")} value={ctx.length ? ctx.map(([k, v]) => `${k}=${v}`).join(" · ") : null} />
                    <Tech label={t("sysIssues.adv.sample")} value={e.sample_reason} />
                    <Tech label={t("sysIssues.adv.count")} value={String(e.coalesced_count)} />
                  </View>
                );
              })}
            </>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function SectionError({ t, isRTL, onRetry }: { t: (k: string) => string; isRTL: boolean; onRetry: () => void }) {
  return (
    <View style={styles.sectionError} accessibilityRole="alert">
      <AppText variant="secondary" color={theme.colors.error} isRTL={isRTL}>
        {t("sysIssues.detail.sectionError")}
      </AppText>
      <PrimaryButton label={t("sysIssues.list.retry")} onPress={onRetry} variant="ghost" size="compact" />
    </View>
  );
}

function Section({ title, isRTL, children }: { title: string; isRTL: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <AppText variant="title" isRTL={isRTL}>
        {title}
      </AppText>
      {children}
    </View>
  );
}

function Fact({ label, value, sub, isRTL }: { label: string; value: string; sub?: string; isRTL: boolean }) {
  return (
    <View style={[styles.fact, rowFlipFor(isRTL) && styles.rowRtl]}>
      <AppText variant="caption" muted style={styles.factLabel} isRTL={isRTL}>
        {label}
      </AppText>
      <View style={styles.factValue}>
        <AppText variant="secondary" isRTL={isRTL}>
          {value}
        </AppText>
        {sub ? (
          <AppText variant="helper" soft isRTL={isRTL}>
            {sub}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

/** A technical field: label plus a left-to-right (code-like) value, always wrapping, never clipped. */
function Tech({ label, value }: { label: string; value: string | null | undefined }) {
  const { t, isRTL } = useI18n();
  return (
    <View style={styles.tech}>
      <AppText variant="label" muted isRTL={isRTL}>
        {label}
      </AppText>
      <AppText variant="secondary" style={styles.techValue} selectable>
        {value && value.length > 0 ? value : t("sysIssues.adv.none")}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { paddingTop: theme.spacing.md, gap: theme.spacing.sm },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: theme.spacing.xs,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs, alignItems: "center" },
  rowRtl: { flexDirection: "row-reverse" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
  actionBtn: { flexGrow: 1, minWidth: 140 },
  item: { paddingVertical: theme.spacing.xs, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderMuted },
  fact: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, paddingVertical: 4 }, // wraps the value under its label on very narrow / zoomed screens
  factLabel: { width: 112 },
  factValue: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 0, gap: 2 },
  bars: { flexDirection: "row", writingDirection: "ltr", alignItems: "flex-end", height: 48, gap: 3 },
  barSlot: { flex: 1, height: 48, justifyContent: "flex-end" },
  bar: { width: "100%", borderRadius: 3, backgroundColor: theme.colors.warning },
  advToggle: { minHeight: theme.controls.minTouch, justifyContent: "center", paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.borderMuted, backgroundColor: theme.colors.surface },
  sectionError: { gap: theme.spacing.xs },
  advHead: { marginTop: theme.spacing.xs },
  tech: { gap: 2, paddingVertical: 2 },
  techValue: { textAlign: "left", writingDirection: "ltr" },
});
