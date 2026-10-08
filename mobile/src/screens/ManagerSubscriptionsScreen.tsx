import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { supabase } from "../lib/supabase";
import { AppSearchField } from "../components/AppSearchField";
import { EmptyState } from "../components/EmptyState";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { PrimaryButton } from "../components/PrimaryButton";
import { SlidingPillTabBar } from "../components/SlidingPillTabBar";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { ManagerMoneyHubTabs } from "../components/ManagerOverviewTabs";
import { formatISODateFull } from "../lib/dateFormat";
import type { LanguageCode } from "../i18n/translations";
import {
  rpcListActiveSubscriptions,
  rpcListSubscriptionHistory,
  type SubscriptionHistoryRow,
  type SubscriptionListRow,
} from "../lib/subscriptions";
import { rowFlipFor } from "../lib/layoutDirection";
import { displayMoney } from "../lib/displayFormat";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

type Tab = "active" | "history";

function statusLabelKey(status: string): string {
  switch (status) {
    case "active":
      return "subscriptions.statusActive";
    case "frozen":
      return "subscriptions.statusFrozen";
    case "scheduled":
      return "subscriptions.statusScheduled";
    case "stopped":
      return "subscriptions.statusStopped";
    case "completed":
      return "subscriptions.statusCompleted";
    case "superseded":
      return "subscriptions.statusSuperseded";
    default:
      return "subscriptions.statusActive";
  }
}

export function ManagerSubscriptionsScreen() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("standard");

  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SubscriptionListRow[]>([]);
  const [history, setHistory] = useState<SubscriptionHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, h] = await Promise.all([rpcListActiveSubscriptions(supabase), rpcListSubscriptionHistory(supabase)]);
      setActive(a);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscriptions.errorLoad"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Refetch every time this screen regains focus (e.g. returning from Create/Edit/Freeze/Stop/
  // Reactivate, which are now separate pushed routes, not modals that could refresh state inline).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const filteredActive = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((r) => r.payee_display_name.toLowerCase().includes(q));
  }, [active, query]);

  const filteredHistory = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return history;
    return history.filter((r) => r.payee_display_name.toLowerCase().includes(q));
  }, [history, query]);

  const tabs = useMemo(
    () => [
      { id: "active" as const, label: t("subscriptions.tabActive") },
      { id: "history" as const, label: t("subscriptions.tabHistory") },
    ],
    [t]
  );

  return (
    <View style={styles.screen}>
      <ManagerMoneyHubTabs />
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, screenContent]} keyboardShouldPersistTaps="handled">
        <View style={[styles.headerRow, rowFlipFor(isRTL) && styles.headerRowRtl]}>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.title")}</Text>
          <PrimaryButton
            label={t("subscriptions.create")}
            onPress={() => router.push("/(app)/manager/subscriptions/create")}
            style={styles.createBtn}
          />
        </View>

        <SlidingPillTabBar tabs={tabs} active={tab} onChange={(id) => setTab(id as Tab)} style={styles.tabBar} />

        <AppSearchField
          value={query}
          onChangeText={setQuery}
          onSearch={() => {}}
          placeholder={t("subscriptions.searchPlaceholder")}
          isRTL={isRTL}
          style={styles.search}
        />

        <FadeSlideIn key={tab} style={styles.body}>
          {loading ? (
            <View style={styles.skeletons}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : error ? (
            <EmptyState
              tone="error"
              title={t("subscriptions.errorLoad")}
              actionLabel={t("subscriptions.retry")}
              onAction={() => void load()}
              isRTL={isRTL}
            />
          ) : tab === "active" ? (
            filteredActive.length === 0 ? (
              <EmptyState icon="list-outline" title={t("subscriptions.emptyActiveTitle")} body={t("subscriptions.emptyActiveBody")} isRTL={isRTL} />
            ) : (
              filteredActive.map((row) => (
                <ActiveSubscriptionRow
                  key={row.subscription_id}
                  row={row}
                  language={language}
                  isRTL={isRTL}
                  t={t}
                  onPress={() => router.push(`/(app)/manager/subscriptions/${row.subscription_id}`)}
                />
              ))
            )
          ) : filteredHistory.length === 0 ? (
            <EmptyState icon="archive-outline" title={t("subscriptions.emptyHistoryTitle")} body={t("subscriptions.emptyHistoryBody")} isRTL={isRTL} />
          ) : (
            filteredHistory.map((row) => (
              <HistorySubscriptionRow
                key={row.subscription_id}
                row={row}
                isRTL={isRTL}
                t={t}
                onPress={() => router.push(`/(app)/manager/subscriptions/${row.subscription_id}`)}
              />
            ))
          )}
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

function ActiveSubscriptionRow({
  row,
  language,
  isRTL,
  t,
  onPress,
}: {
  row: SubscriptionListRow;
  language: LanguageCode;
  isRTL: boolean;
  t: (k: string) => string;
  onPress: () => void;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress} accessibilityRole="button">
      <View style={[styles.rowTop, rowFlipFor(isRTL) && styles.rowTopRtl]}>
        <Text style={[styles.rowName, isRTL && styles.rtl]} numberOfLines={1}>
          {row.payee_display_name}
        </Text>
        <View style={[styles.badges, rowFlipFor(isRTL) && styles.badgesRtl]}>
          {row.is_frozen ? (
            <View style={[styles.badge, styles.badgeFrozen]}>
              <Text style={styles.badgeText}>{t("subscriptions.frozenBadge")}</Text>
            </View>
          ) : null}
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{t(statusLabelKey(row.display_status))}</Text>
          </View>
        </View>
      </View>
      <Text style={[styles.rowSub, isRTL && styles.rtl]}>{displayMoney(row.monthly_price_ils)} / mo</Text>
      <View style={[styles.rowMeta, rowFlipFor(isRTL) && styles.rowMetaRtl]}>
        <Text style={[styles.rowMetaText, isRTL && styles.rtl]}>
          {t("subscriptions.rowStart")}: {formatISODateFull(row.plan_start_date, language)}
        </Text>
        <Text style={[styles.rowMetaText, isRTL && styles.rtl]}>
          {row.has_no_end_date || !row.plan_end_date
            ? t("subscriptions.noEndDate")
            : `${t("subscriptions.rowEnd")}: ${formatISODateFull(row.plan_end_date, language)}`}
        </Text>
      </View>
      {row.next_billing_date ? (
        <Text style={[styles.rowMetaText, isRTL && styles.rtl]}>
          {t("subscriptions.rowNextBilling")}: {formatISODateFull(row.next_billing_date, language)}
        </Text>
      ) : null}
    </Pressable>
  );
}

function HistorySubscriptionRow({
  row,
  isRTL,
  t,
  onPress,
}: {
  row: SubscriptionHistoryRow;
  isRTL: boolean;
  t: (k: string) => string;
  onPress: () => void;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress} accessibilityRole="button">
      <View style={[styles.rowTop, rowFlipFor(isRTL) && styles.rowTopRtl]}>
        <Text style={[styles.rowName, isRTL && styles.rtl]} numberOfLines={1}>
          {row.payee_display_name}
        </Text>
        <View style={[styles.badges, rowFlipFor(isRTL) && styles.badgesRtl]}>
          {row.is_tombstoned ? (
            <View style={[styles.badge, styles.badgeMuted]}>
              <Text style={styles.badgeText}>{t("subscriptions.tombstonedBadge")}</Text>
            </View>
          ) : (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{t(statusLabelKey(row.display_status))}</Text>
            </View>
          )}
        </View>
      </View>
      <Text style={[styles.rowSub, isRTL && styles.rtl]}>{displayMoney(row.monthly_price_ils)} / mo</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  content: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: 40 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  headerRowRtl: { flexDirection: "row-reverse" },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  createBtn: { flexShrink: 0 },
  tabBar: { marginBottom: theme.spacing.sm },
  search: { marginBottom: theme.spacing.md },
  body: { gap: theme.spacing.sm },
  skeletons: { gap: theme.spacing.sm },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: 4,
    marginBottom: theme.spacing.sm,
  },
  rowPressed: { opacity: 0.85 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm },
  rowTopRtl: { flexDirection: "row-reverse" },
  rowName: { fontSize: 15, fontWeight: "800", color: theme.colors.text, flex: 1 },
  badges: { flexDirection: "row", gap: 6 },
  badgesRtl: { flexDirection: "row-reverse" },
  badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: theme.radius.full, backgroundColor: theme.colors.surfaceElevated },
  badgeFrozen: { backgroundColor: "#2a2a3f" },
  badgeMuted: { backgroundColor: theme.colors.borderMuted },
  badgeText: { fontSize: 11, fontWeight: "800", color: theme.colors.textMuted },
  rowSub: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  rowMeta: { flexDirection: "row", gap: theme.spacing.md, flexWrap: "wrap" },
  rowMetaRtl: { flexDirection: "row-reverse" },
  rowMetaText: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
