import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { AppText } from "../components/AppText";
import { AppIcon } from "../components/AppIcon";
import { PrimaryButton } from "../components/PrimaryButton";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { ChipRow } from "../components/systemIssues/ChipRow";
import { IssueRow } from "../components/systemIssues/IssueRow";
import { SummaryCards } from "../components/systemIssues/SummaryCards";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { rowFlipFor } from "../lib/layoutDirection";
import { fetchIssuePage, fetchSummary } from "../lib/systemIssues/queries";
import { useRefetchOnResume } from "../hooks/useRefetchOnResume";
import { DEFAULT_FILTERS, type EnvironmentFilter, type IssueFilters, type IssueSummary, type SortKey, type StatusFilter, type SystemIssueRow } from "../lib/systemIssues/types";

const STATUS_OPTS: StatusFilter[] = ["active", "open", "acknowledged", "muted", "resolved", "all"];
const SEVERITY_OPTS = ["all", "critical", "error", "warning", "info"] as const;
const SOURCE_OPTS = ["all", "cron", "client", "db", "edge", "other"] as const;
const RECENCY_OPTS = ["all", "24h", "7d", "30d"] as const;
const ENVIRONMENT_OPTS: EnvironmentFilter[] = ["production", "development", "all"];
const SORT_OPTS: SortKey[] = ["recent", "severe", "frequent"];

type LoadState = "loading" | "ready" | "error";

function activeFilterCount(f: IssueFilters): number {
  return (
    (f.status !== DEFAULT_FILTERS.status ? 1 : 0) +
    (f.severity !== "all" ? 1 : 0) +
    (f.source !== "all" ? 1 : 0) +
    (f.recency !== "all" ? 1 : 0) +
    (f.environment !== DEFAULT_FILTERS.environment ? 1 : 0)
  );
}

/**
 * Manager "System issues": dashboard counters, filterable / sortable list with server-side paging, and navigation to the detail screen.
 * Refresh strategy: when the screen gains focus, on pull-to-refresh and after a filter change. No polling and no realtime subscription.
 */
export default function ManagerSystemIssuesScreen() {
  const { t, isRTL, language } = useI18n();
  const content = useScreenContentStyle("standard");
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>("recent");
  const [rows, setRows] = useState<SystemIssueRow[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const reqId = useRef(0);
  const focused = useRef(false);
  const current = useRef({ filters, sort });
  useEffect(() => {
    current.current = { filters, sort };
  }, [filters, sort]);

  const markFresh = useRef<() => void>(() => undefined);
  const loadList = useCallback(async (f: IssueFilters, s: SortKey) => {
    const id = ++reqId.current;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    try {
      const res = await fetchIssuePage(supabase, f, s, 0);
      if (id !== reqId.current) return; // a newer request superseded this one
      setRows(res.rows);
      setHasMore(res.hasMore);
      setPage(0);
      setMoreError(false);
      setNow(Date.now());
      markFresh.current();
      setState("ready");
    } catch {
      if (id !== reqId.current) return;
      setState("error");
    }
  }, []);

  const loadSummary = useCallback(async (environment: EnvironmentFilter) => {
    setSummaryLoading(true);
    try {
      setSummary(await fetchSummary(supabase, Date.now(), environment));
    } catch {
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  // One parallel round on focus: list and counters. Also when the installed app / tab returns to the foreground (see useRefetchOnResume).
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void loadList(current.current.filters, current.current.sort);
      void loadSummary(current.current.filters.environment);
      return () => {
        focused.current = false;
      };
    }, [loadList, loadSummary])
  );
  const markFreshFn = useRefetchOnResume(
    () => {
      void loadList(current.current.filters, current.current.sort);
      void loadSummary(current.current.filters.environment);
    },
    () => focused.current
  );
  useEffect(() => {
    markFresh.current = markFreshFn;
  }, [markFreshFn]);

  function changeFilters(next: IssueFilters) {
    if (
      next.status === filters.status &&
      next.severity === filters.severity &&
      next.source === filters.source &&
      next.recency === filters.recency &&
      next.environment === filters.environment
    )
      return; // re-selecting the current option is not a change
    setFilters(next);
    setState("loading");
    void loadList(next, sort);
    if (next.environment !== filters.environment) void loadSummary(next.environment);
  }
  function changeSort(next: SortKey) {
    if (next === sort) return;
    setSort(next);
    setState("loading");
    void loadList(filters, next);
  }

  async function loadMore() {
    if (moreBusy || !hasMore) return;
    setMoreBusy(true);
    setMoreError(false);
    const id = reqId.current;
    try {
      const res = await fetchIssuePage(supabase, filters, sort, page + 1);
      if (id !== reqId.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...res.rows.filter((r) => !seen.has(r.id))];
      });
      setPage((p) => p + 1);
      setHasMore(res.hasMore);
    } catch {
      setMoreError(true);
    } finally {
      setMoreBusy(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([loadList(filters, sort), loadSummary(filters.environment)]);
    setRefreshing(false);
  }

  const nFilters = activeFilterCount(filters);
  const statusOptions = useMemo(() => STATUS_OPTS.map((v) => ({ value: v, label: t(`sysIssues.filterStatus.${v}`) })), [t]);
  const severityOptions = useMemo(() => SEVERITY_OPTS.map((v) => ({ value: v, label: t(`sysIssues.severity.${v}`) })), [t]);
  const sourceOptions = useMemo(() => SOURCE_OPTS.map((v) => ({ value: v, label: t(`sysIssues.source.${v}`) })), [t]);
  const recencyOptions = useMemo(() => RECENCY_OPTS.map((v) => ({ value: v, label: t(`sysIssues.recency.${v}`) })), [t]);
  const environmentOptions = useMemo(() => ENVIRONMENT_OPTS.map((v) => ({ value: v, label: t(`sysIssues.environment.${v}`) })), [t]);
  const sortOptions = useMemo(() => SORT_OPTS.map((v) => ({ value: v, label: t(`sysIssues.sort.${v}`) })), [t]);

  const header = (
    <View style={styles.header}>
      <ManagerStudioSetupTabs />
      <AppText variant="display" isRTL={isRTL}>
        {t("sysIssues.title")}
      </AppText>
      <AppText variant="secondary" muted isRTL={isRTL}>
        {t("sysIssues.hint")}
      </AppText>
      <SummaryCards summary={summary} loading={summaryLoading} t={t} isRTL={isRTL} lang={language} onPickStatus={(s) => changeFilters({ ...filters, status: s })} />
      <Pressable
        onPress={() => setFiltersOpen((o) => !o)}
        style={({ pressed }) => [styles.filterToggle, rowFlipFor(isRTL) && styles.rowRtl, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded: filtersOpen }}
        accessibilityLabel={t("sysIssues.filters")}
      >
        <AppIcon name="options-outline" size="md" color={theme.colors.textMuted} />
        <AppText variant="title" style={styles.flex}>
          {t("sysIssues.filters")}
          {nFilters > 0 ? ` (${nFilters})` : ""}
        </AppText>
        <AppIcon name={filtersOpen ? "chevron-up" : "chevron-down"} size="md" color={theme.colors.textMuted} />
      </Pressable>
      {filtersOpen ? (
        <View style={styles.filterPanel}>
          <ChipRow label={t("sysIssues.filter.status")} options={statusOptions} value={filters.status} onChange={(v) => changeFilters({ ...filters, status: v })} isRTL={isRTL} />
          <ChipRow label={t("sysIssues.filter.severity")} options={severityOptions} value={filters.severity} onChange={(v) => changeFilters({ ...filters, severity: v })} isRTL={isRTL} />
          <ChipRow label={t("sysIssues.filter.source")} options={sourceOptions} value={filters.source} onChange={(v) => changeFilters({ ...filters, source: v })} isRTL={isRTL} />
          <ChipRow label={t("sysIssues.filter.recency")} options={recencyOptions} value={filters.recency} onChange={(v) => changeFilters({ ...filters, recency: v })} isRTL={isRTL} />
          <ChipRow label={t("sysIssues.filter.environment")} options={environmentOptions} value={filters.environment} onChange={(v) => changeFilters({ ...filters, environment: v })} isRTL={isRTL} />
          <ChipRow label={t("sysIssues.filter.sort")} options={sortOptions} value={sort} onChange={changeSort} isRTL={isRTL} />
          {nFilters > 0 ? <PrimaryButton label={t("sysIssues.filters.reset")} onPress={() => changeFilters(DEFAULT_FILTERS)} variant="ghost" size="compact" /> : null}
        </View>
      ) : null}
    </View>
  );

  let body: React.ReactNode = null;
  if (state === "loading" && rows.length === 0) {
    body = (
      <View style={styles.list} accessibilityLabel={t("sysIssues.list.loadingMore")}>
        {[0, 1, 2, 3].map((i) => (
          <ListRowSkeleton key={i} />
        ))}
      </View>
    );
  } else if (state === "error" && rows.length === 0) {
    body = <ErrorState title={t("sysIssues.list.error.title")} body={t("sysIssues.list.error.body")} actionLabel={t("sysIssues.list.retry")} onAction={() => void loadList(filters, sort)} isRTL={isRTL} />;
  } else if (rows.length === 0) {
    body =
      nFilters > 0 ? (
        <EmptyState title={t("sysIssues.list.noMatch.title")} body={t("sysIssues.list.noMatch.body")} icon="funnel-outline" actionLabel={t("sysIssues.filters.reset")} onAction={() => changeFilters(DEFAULT_FILTERS)} isRTL={isRTL} />
      ) : (
        <EmptyState title={t("sysIssues.list.empty.title")} body={t("sysIssues.list.empty.body")} icon="shield-checkmark-outline" isRTL={isRTL} />
      );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={[styles.content, content]}
      data={rows}
      keyExtractor={(r) => r.id}
      ListHeaderComponent={header}
      ListEmptyComponent={body}
      ItemSeparatorComponent={Separator}
      renderItem={({ item }) => (
        <IssueRow issue={item} now={now} t={t} isRTL={isRTL} lang={language} environment={filters.environment} onPress={() => router.push(`/(app)/manager/system-issues/${item.id}` as never)} />
      )}
      ListFooterComponent={
        hasMore ? (
          <View style={styles.footer}>
            {moreError ? (
              <AppText variant="helper" color={theme.colors.error} isRTL={isRTL}>
                {t("sysIssues.list.error.body")}
              </AppText>
            ) : null}
            <PrimaryButton label={t("sysIssues.list.loadMore")} loadingLabel={t("sysIssues.list.loadingMore")} loading={moreBusy} onPress={() => void loadMore()} variant="ghost" />
          </View>
        ) : null
      }
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={theme.colors.textMuted} />}
      initialNumToRender={10}
      windowSize={7}
    />
  );
}

function Separator() {
  return <View style={{ height: theme.spacing.sm }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { paddingTop: theme.spacing.md },
  header: { gap: theme.spacing.sm, marginBottom: theme.spacing.md },
  list: { gap: theme.spacing.sm },
  flex: { flex: 1 },
  rowRtl: { flexDirection: "row-reverse" },
  filterToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    minHeight: theme.controls.minTouch,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  filterPanel: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  footer: { marginTop: theme.spacing.md, gap: theme.spacing.xs, alignItems: "stretch" },
});
