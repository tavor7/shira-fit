import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { DateRangeFormPanel } from "../components/DateRangeFormPanel";
import { PrimaryButton } from "../components/PrimaryButton";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { EmptyState } from "../components/EmptyState";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";
import { activityEventLooksRevertible, activityRevertReasonLabel } from "../lib/activityLogRevert";
import {
  activityLogEventLabel,
  buildActivityLogDetailLines,
  collectActivityLogIds,
  type ActivityLogRow,
} from "../lib/activityLogDetails";

type Row = ActivityLogRow;

type SessionRow = {
  id: string;
  session_date: string;
  start_time: string;
  max_participants: number;
  duration_minutes: number;
  coach_id: string;
};

function formatWhen(iso: string, language: string) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(language === "he" ? "he-IL" : "en-GB", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

type DatePreset = "7" | "14" | "30" | "90" | "all" | "custom";

type ActivityGroupId = "all" | "auth" | "profiles" | "sessions" | "registration";

const ACTIVITY_GROUP_TYPES: Record<Exclude<ActivityGroupId, "all">, string[]> = {
  auth: ["auth_login", "email_confirmed", "password_reset_completed", "signup_completed"],
  profiles: [
    "athlete_profile_created",
    "profile_created",
    "profile_updated",
    "athlete_approved",
    "athlete_rejected",
    "athlete_approval_updated",
    "user_role_changed",
    "manual_participant_created",
    "manual_participant_updated",
    "athlete_family_created",
    "athlete_family_updated",
    "athlete_family_deleted",
  ],
  sessions: [
    "session_created",
    "session_updated",
    "session_deleted",
    "session_note_created",
    "session_note_updated",
    "session_note_deleted",
    "calendar_note_created",
    "calendar_note_updated",
    "calendar_note_deleted",
  ],
  registration: [
    "session_registration",
    "session_registration_cancelled",
    "session_registration_status_changed",
    "session_manual_participant_added",
    "session_manual_participant_removed",
    "registration_attendance_updated",
    "manual_participant_attendance_updated",
    "waitlist_request_created",
    "waitlist_request_removed",
    "cancellation_charge_updated",
    "cancellation_penalty_collected_updated",
    "registration_opening_schedule_updated",
    "account_payment_created",
    "account_payment_updated",
    "account_payment_deleted",
    "pricing_setting_created",
    "pricing_setting_updated",
    "pricing_setting_deleted",
    "activity_event_reverted",
  ],
};

function eventTypesForActivityGroup(g: ActivityGroupId): string[] | null {
  if (g === "all") return null;
  return ACTIVITY_GROUP_TYPES[g];
}

const RETENTION_CHIPS = [7, 14, 30, 60, 90, 180, 365] as const;

const PAGE_SIZE = 25;

function isoBoundsFromLocalDates(dateFrom: string, dateTo: string): { startIso: string; endIso: string } | null {
  let df = parseISODateLocal(dateFrom);
  let dt = parseISODateLocal(dateTo);
  if (!df || !dt) return null;
  if (df.getTime() > dt.getTime()) {
    const s = df;
    df = dt;
    dt = s;
  }
  const start = new Date(df.getFullYear(), df.getMonth(), df.getDate(), 0, 0, 0, 0);
  const end = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function computePresetRange(preset: DatePreset, retentionDays: number): { from: string; to: string } {
  const now = new Date();
  const to = toISODateLocal(now);
  const toD = parseISODateLocal(to);
  if (!toD) return { from: to, to };
  let daysBack: number;
  switch (preset) {
    case "7":
      daysBack = 7;
      break;
    case "14":
      daysBack = 14;
      break;
    case "30":
      daysBack = 30;
      break;
    case "90":
      daysBack = 90;
      break;
    case "all":
      daysBack = Math.max(1, retentionDays);
      break;
    default:
      daysBack = 14;
  }
  const fromD = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() - (daysBack - 1));
  return { from: toISODateLocal(fromD), to };
}

function ChipButton({
  label,
  active,
  onPress,
  compact,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        compact && styles.chipCompact,
        active && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipLabel, compact && styles.chipLabelCompact, active && styles.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

async function fetchProfileLabels(userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out: Record<string, string> = {};
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase.from("profiles").select("user_id, full_name, username").in("user_id", chunk);
    for (const p of data ?? []) {
      const row = p as { user_id: string; full_name: string | null; username: string | null };
      const fn = (row.full_name ?? "").trim();
      const un = (row.username ?? "").trim();
      out[row.user_id] = fn ? (un ? `${fn} (@${un})` : fn) : un ? `@${un}` : row.user_id;
    }
  }
  return out;
}

async function fetchManualParticipantLabels(manualIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(manualIds.filter(Boolean))];
  const out: Record<string, string> = {};
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase.from("manual_participants").select("id, full_name, phone").in("id", chunk);
    for (const p of data ?? []) {
      const row = p as { id: string; full_name: string | null; phone: string | null };
      const fn = (row.full_name ?? "").trim();
      const ph = (row.phone ?? "").trim();
      out[row.id] = fn && ph ? `${fn} · ${ph}` : fn ? fn : ph ? ph : row.id;
    }
  }
  return out;
}

async function fetchSessionsRaw(ids: string[]): Promise<SessionRow[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: SessionRow[] = [];
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase
      .from("training_sessions")
      .select("id, session_date, start_time, max_participants, duration_minutes, coach_id")
      .in("id", chunk);
    for (const s of data ?? []) out.push(s as SessionRow);
  }
  return out;
}

function sessionOneLine(s: SessionRow, _language: string): string {
  const time = String(s.start_time ?? "").slice(0, 5);
  return `${s.session_date} · ${time} · max ${s.max_participants} · ${s.duration_minutes} min`;
}

export default function ManagerActivityLogScreen() {
  const { language, isRTL, t } = useI18n();
  const { showOk, showConfirm } = useAppAlert();
  const initRange = computePresetRange("14", 14);
  const [dateFrom, setDateFrom] = useState(initRange.from);
  const [dateTo, setDateTo] = useState(initRange.to);
  const [datePreset, setDatePreset] = useState<DatePreset>("14");
  const [retentionDays, setRetentionDays] = useState(14);
  const [retentionDraft, setRetentionDraft] = useState(14);
  const [savingRetention, setSavingRetention] = useState(false);
  const [activityGroup, setActivityGroup] = useState<ActivityGroupId>("all");
  const [retentionExpanded, setRetentionExpanded] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [profileLabels, setProfileLabels] = useState<Record<string, string>>({});
  const [manualLabels, setManualLabels] = useState<Record<string, string>>({});
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  const reload = useCallback(
    async (forcePage?: number) => {
      const bounds = isoBoundsFromLocalDates(dateFrom, dateTo);
      if (!bounds) {
        setRows([]);
        setProfileLabels({});
        setManualLabels({});
        setSessionSummaries({});
        setTotalCount(0);
        setLoading(false);
        return;
      }

      const effectivePage = forcePage !== undefined ? forcePage : pageIndex;

      setLoading(true);
      try {
        await supabase.rpc("manager_prune_activity_logs");
        const { data: retRaw } = await supabase.rpc("get_activity_log_retention_days");
        const ret = Math.min(730, Math.max(1, Number(retRaw) || 14));
        setRetentionDays(ret);

        const typeFilter = eventTypesForActivityGroup(activityGroup);
        const rangeFrom = effectivePage * PAGE_SIZE;
        const rangeTo = rangeFrom + PAGE_SIZE - 1;

        let evQuery = supabase
          .from("user_activity_events")
          .select("id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at", {
            count: "exact",
          })
          .gte("created_at", bounds.startIso)
          .lte("created_at", bounds.endIso);
        if (typeFilter) evQuery = evQuery.in("event_type", typeFilter);
        const { data, error, count } = await evQuery
          .order("created_at", { ascending: false })
          .range(rangeFrom, rangeTo);

        const total = typeof count === "number" ? count : 0;
        setTotalCount(total);

        const maxPageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        if (total > 0 && effectivePage > maxPageIndex) {
          setPageIndex(maxPageIndex);
          return;
        }
        if (total === 0 && effectivePage > 0) {
          setPageIndex(0);
          return;
        }

        if (forcePage !== undefined && forcePage !== pageIndex) {
          setPageIndex(forcePage);
        }

        const list = !error && data ? (data as Row[]) : [];
        setRows(list);

        const profileIds = new Set<string>();
        const sessionIds = new Set<string>();
        const manualIds = new Set<string>();
        for (const r of list) collectActivityLogIds(r, profileIds, sessionIds, manualIds);

        const sessions = await fetchSessionsRaw([...sessionIds]);
        const sum: Record<string, string> = {};
        for (const s of sessions) {
          sum[s.id] = sessionOneLine(s, language);
          profileIds.add(s.coach_id);
        }
        setSessionSummaries(sum);

        const [labels, manual] = await Promise.all([
          fetchProfileLabels([...profileIds]),
          fetchManualParticipantLabels([...manualIds]),
        ]);
        setProfileLabels(labels);
        setManualLabels(manual);
      } finally {
        setLoading(false);
      }
    },
    [activityGroup, dateFrom, dateTo, language, pageIndex]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }

  function onPickDatePreset(p: DatePreset) {
    setPageIndex(0);
    setDatePreset(p);
    if (p !== "custom") {
      const r = computePresetRange(p, retentionDays);
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  }

  async function saveRetention() {
    setSavingRetention(true);
    try {
      const { data, error } = await supabase.rpc("set_activity_log_retention_days", { p_days: retentionDraft });
      if (error) throw error;
      const parsed = data as { ok?: boolean; deleted?: number; retention_days?: number };
      if (parsed && parsed.ok === false) {
        showOk(t("common.error"), t("activityLog.purgeFailed"));
        return;
      }
      const d = parsed?.retention_days ?? retentionDraft;
      const n = parsed?.deleted ?? 0;
      setRetentionDays(d);
      setRetentionDraft(d);
      const msg = t("activityLog.purgeDone").replace(/\{d\}/g, String(d)).replace(/\{n\}/g, String(n));
      showOk(t("common.saved"), msg);
      if (datePreset === "all") {
        const r = computePresetRange("all", d);
        setDateFrom(r.from);
        setDateTo(r.to);
      }
      await reload(0);
    } catch (e) {
      showOk(t("common.error"), e instanceof Error ? e.message : t("activityLog.purgeFailed"));
    } finally {
      setSavingRetention(false);
    }
  }

  function requestRevert(item: Row) {
    const run = async () => {
      setRevertingId(item.id);
      try {
        const { data, error } = await supabase.rpc("manager_revert_activity_event", { p_event_id: item.id });
        if (error) throw error;
        const parsed = data as { ok?: boolean; error?: string };
        if (!parsed?.ok) {
          const reason = parsed?.error ?? "not_revertible";
          showOk(t("common.error"), activityRevertReasonLabel(reason, language));
          return;
        }
        showOk(t("common.saved"), t("activityLog.revertDone"));
        await reload(pageIndex);
      } catch (e) {
        showOk(t("common.error"), e instanceof Error ? e.message : t("activityLog.revertFailed"));
      } finally {
        setRevertingId(null);
      }
    };

    void (async () => {
      setRevertingId(item.id);
      try {
        const { data, error } = await supabase.rpc("manager_activity_revert_info", { p_event_id: item.id });
        if (error) throw error;
        const info = data as { ok?: boolean; can_revert?: boolean; reason?: string; error?: string };
        if (!info?.ok) {
          const reason = info?.error ?? info?.reason ?? "not_revertible";
          showOk(t("common.error"), activityRevertReasonLabel(reason, language));
          return;
        }
        if (!info.can_revert) {
          showOk(t("common.error"), activityRevertReasonLabel(info.reason ?? "not_revertible", language));
          return;
        }
        showConfirm({
          title: t("activityLog.revertConfirmTitle"),
          message: t("activityLog.revertConfirmBody"),
          cancelLabel: t("common.cancel"),
          confirmLabel: t("activityLog.revertAction"),
          confirmVariant: "danger",
          onConfirm: () => void run(),
        });
      } catch (e) {
        showOk(t("common.error"), e instanceof Error ? e.message : t("activityLog.revertFailed"));
      } finally {
        setRevertingId(null);
      }
    })();
  }

  const datePresetRows: { preset: DatePreset; labelKey: string }[] = [
    { preset: "7", labelKey: "activityLog.preset7" },
    { preset: "14", labelKey: "activityLog.preset14" },
    { preset: "30", labelKey: "activityLog.preset30" },
    { preset: "90", labelKey: "activityLog.preset90" },
    { preset: "all", labelKey: "activityLog.presetAll" },
    { preset: "custom", labelKey: "activityLog.presetCustom" },
  ];

  const activityGroupRows: { id: ActivityGroupId; labelKey: string }[] = [
    { id: "all", labelKey: "activityLog.typeAll" },
    { id: "auth", labelKey: "activityLog.typeAuth" },
    { id: "profiles", labelKey: "activityLog.typeProfiles" },
    { id: "sessions", labelKey: "activityLog.typeSessions" },
    { id: "registration", labelKey: "activityLog.typeRegistrations" },
  ];

  const filtersSection = (
    <View style={styles.headerBlock}>
      <View style={styles.filterCard}>
        <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>{t("activityLog.filterTitle")}</Text>
        <View style={styles.chipWrap}>
          {datePresetRows.map(({ preset, labelKey }) => (
            <ChipButton
              key={preset}
              label={t(labelKey)}
              active={datePreset === preset}
              onPress={() => onPickDatePreset(preset)}
              compact
            />
          ))}
        </View>
        {datePreset === "custom" ? (
          <View style={styles.customDates}>
            <DateRangeFormPanel
              fromLabel={t("common.from")}
              toLabel={t("common.to")}
              start={dateFrom}
              end={dateTo}
              onStartChange={(v) => {
                setPageIndex(0);
                setDateFrom(v);
                setDatePreset("custom");
              }}
              onEndChange={(v) => {
                setPageIndex(0);
                setDateTo(v);
                setDatePreset("custom");
              }}
              maximumStart={parseISODateLocal(dateTo) ?? undefined}
              minimumEnd={parseISODateLocal(dateFrom) ?? undefined}
            />
          </View>
        ) : null}

        <Text style={[styles.sectionLabel, styles.sectionLabelSpaced, isRTL && styles.rtl]}>
          {t("activityLog.activityType")}
        </Text>
        <View style={styles.chipWrap}>
          {activityGroupRows.map(({ id, labelKey }) => (
            <ChipButton
              key={id}
              label={t(labelKey)}
              active={activityGroup === id}
              onPress={() => {
                setPageIndex(0);
                setActivityGroup(id);
              }}
              compact
            />
          ))}
        </View>
      </View>

      <View style={styles.retentionShell}>
        <Pressable
          onPress={() => setRetentionExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: retentionExpanded }}
          accessibilityLabel={t("a11y.activityLogToggleRetention")}
          style={({ pressed }) => [
            styles.retentionHeader,
            isRTL && styles.retentionHeaderRtl,
            pressed && styles.retentionHeaderPressed,
          ]}
        >
          <View style={[styles.retentionHeaderMain, isRTL && styles.retentionHeaderMainRtl]}>
            <Text style={[styles.retentionHeaderTitle, isRTL && styles.rtl]}>{t("activityLog.retentionTitle")}</Text>
            <Text style={[styles.retentionHeaderSummary, isRTL && styles.rtl]}>
              {t("activityLog.currentRetention").replace(/\{d\}/g, String(retentionDays))}
            </Text>
            {!retentionExpanded ? (
              <Text style={[styles.retentionHeaderHint, isRTL && styles.rtl]}>{t("activityLog.retentionTapToExpand")}</Text>
            ) : null}
          </View>
          <Text style={styles.retentionChevron}>
            {retentionExpanded ? "\u25bc" : isRTL ? "\u25c0" : "\u25b6"}
          </Text>
        </Pressable>

        {retentionExpanded ? (
          <View style={styles.retentionBody}>
            <Text style={[styles.retentionCaption, isRTL && styles.rtl]}>{t("activityLog.retentionHint")}</Text>
            <View style={styles.chipWrap}>
              {RETENTION_CHIPS.map((d) => (
                <ChipButton key={d} label={`${d}`} active={retentionDraft === d} onPress={() => setRetentionDraft(d)} compact />
              ))}
            </View>
            <PrimaryButton
              label={t("activityLog.savePurge")}
              loadingLabel={t("activityLog.saving")}
              loading={savingRetention}
              onPress={saveRetention}
              style={styles.retentionSaveBtn}
            />
          </View>
        ) : null}
      </View>
    </View>
  );

  const listHeader = (
    <View style={styles.listHeaderPad}>
      <ManagerOverviewHubTabs />
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.activityLog")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>{t("activityLog.hint")}</Text>
      {filtersSection}
    </View>
  );

  const maxPageIndex =
    totalCount !== null && totalCount > 0 ? Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1) : 0;
  const rowFrom = totalCount && totalCount > 0 ? pageIndex * PAGE_SIZE + 1 : 0;
  const rowTo = totalCount && totalCount > 0 ? Math.min((pageIndex + 1) * PAGE_SIZE, totalCount) : 0;
  const pageSummaryText = t("activityLog.pageSummary")
    .replace(/\{from\}/g, String(rowFrom))
    .replace(/\{to\}/g, String(rowTo))
    .replace(/\{total\}/g, String(totalCount ?? 0));

  const listFooter = (
    <View style={styles.listFooterWrap}>
      {loading && rows.length > 0 ? (
        <ActivityIndicator style={styles.footerLoading} color={theme.colors.cta} />
      ) : null}
      {totalCount !== null && totalCount > 0 ? (
        <View style={[styles.paginationBar, isRTL && styles.paginationBarRtl]}>
          <Pressable
            disabled={loading || pageIndex <= 0}
            onPress={() => setPageIndex((p) => Math.max(0, p - 1))}
            style={({ pressed }) => [
              styles.paginationBtn,
              (loading || pageIndex <= 0) && styles.paginationBtnDisabled,
              pressed && !(loading || pageIndex <= 0) && styles.paginationBtnPressed,
            ]}
          >
            <Text
              style={[
                styles.paginationBtnText,
                (loading || pageIndex <= 0) && styles.paginationBtnTextDisabled,
                isRTL && styles.rtl,
              ]}
            >
              {t("activityLog.pagePrev")}
            </Text>
          </Pressable>
          <Text style={[styles.paginationSummary, isRTL && styles.rtl]}>{pageSummaryText}</Text>
          <Pressable
            disabled={loading || pageIndex >= maxPageIndex}
            onPress={() =>
              setPageIndex((p) => {
                const maxP = Math.max(0, Math.ceil((totalCount ?? 0) / PAGE_SIZE) - 1);
                return Math.min(maxP, p + 1);
              })
            }
            style={({ pressed }) => [
              styles.paginationBtn,
              (loading || pageIndex >= maxPageIndex) && styles.paginationBtnDisabled,
              pressed && !(loading || pageIndex >= maxPageIndex) && styles.paginationBtnPressed,
            ]}
          >
            <Text
              style={[
                styles.paginationBtnText,
                (loading || pageIndex >= maxPageIndex) && styles.paginationBtnTextDisabled,
                isRTL && styles.rtl,
              ]}
            >
              {t("activityLog.pageNext")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        style={styles.listFlex}
        data={rows}
        keyExtractor={(i) => i.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.cta} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          loading ? (
            <View style={styles.skeletonList}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : (
            <EmptyState icon="📋" title={t("activityLog.empty")} isRTL={isRTL} />
          )
        }
        ListFooterComponent={listFooter}
        renderItem={({ item }) => {
            const details = buildActivityLogDetailLines(item, profileLabels, manualLabels, sessionSummaries, language);
            const actorLine = item.actor_user_id
              ? `${language === "he" ? "מבצע" : "Actor"}: ${profileLabels[item.actor_user_id] ?? item.actor_user_id}`
              : "—";
            const isReverted = !!item.reverted_at;
            const canRevert = activityEventLooksRevertible(item);
            const revertBusy = revertingId === item.id;
            return (
              <View style={[styles.card, isReverted && styles.cardReverted]}>
                <View style={[styles.cardHeaderRow, isRTL && styles.cardHeaderRowRtl]}>
                  <Text style={[styles.when, isRTL && styles.rtl, styles.whenInHeader]}>{formatWhen(item.created_at, language)}</Text>
                  <View style={[styles.cardHeaderActions, isRTL && styles.cardHeaderActionsRtl]}>
                    {isReverted ? (
                      <View style={styles.revertedBadge}>
                        <Text style={styles.revertedBadgeText}>{t("activityLog.revertedBadge")}</Text>
                      </View>
                    ) : null}
                    {canRevert ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("activityLog.revertAction")}
                        style={({ pressed }) => [
                          styles.revertLink,
                          isRTL && styles.revertLinkRtl,
                          pressed && styles.revertLinkPressed,
                          revertBusy && styles.revertLinkDisabled,
                        ]}
                        disabled={revertBusy}
                        onPress={() => requestRevert(item)}
                      >
                        {revertBusy ? (
                          <ActivityIndicator size="small" color={theme.colors.textMuted} />
                        ) : (
                          <>
                            <Ionicons name="arrow-undo" size={13} color={theme.colors.textSoft} style={styles.revertIcon} />
                            <Text style={[styles.revertLinkText, isRTL && styles.rtl]}>{t("activityLog.revertLink")}</Text>
                          </>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <Text style={[styles.event, isRTL && styles.rtl]}>{activityLogEventLabel(item.event_type, language)}</Text>
                <Text style={[styles.meta, isRTL && styles.rtl]} selectable>
                  {actorLine}
                </Text>
                {details.length > 0 ? (
                  <View style={styles.detailsBox}>
                    <Text style={[styles.detailsTitle, isRTL && styles.rtl]}>
                      {language === "he" ? "פרטים" : "Details"}
                    </Text>
                    {details.map((line, idx) => (
                      <Text key={idx} style={[styles.detailLine, isRTL && styles.rtl]} selectable>
                        {line}
                      </Text>
                    ))}
                  </View>
                ) : item.metadata && Object.keys(item.metadata).length > 0 ? (
                  <Text style={[styles.json, isRTL && styles.rtl]} selectable numberOfLines={6}>
                    {JSON.stringify(item.metadata, null, 0)}
                  </Text>
                ) : null}
              </View>
            );
          }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  listFlex: { flex: 1 },
  listHeaderPad: { paddingTop: theme.spacing.md, paddingBottom: theme.spacing.xs },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.2,
    lineHeight: 26,
  },
  hint: {
    marginTop: theme.spacing.sm,
    color: theme.colors.textMuted,
    lineHeight: 22,
    marginBottom: theme.spacing.md,
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 0.15,
  },
  headerBlock: { marginBottom: theme.spacing.md },
  filterCard: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: theme.spacing.sm,
  },
  sectionLabelSpaced: { marginTop: theme.spacing.md },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    rowGap: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  chipActive: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  chipPressed: { opacity: 0.88 },
  chipCompact: { paddingHorizontal: theme.spacing.sm, paddingVertical: 7 },
  chipLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted, letterSpacing: 0.15 },
  chipLabelCompact: { fontSize: 12 },
  chipLabelActive: { color: theme.colors.ctaText },
  customDates: {
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
  },
  retentionShell: {
    marginTop: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  retentionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  retentionHeaderRtl: { flexDirection: "row-reverse" },
  retentionHeaderPressed: { opacity: 0.92 },
  retentionHeaderMain: { flex: 1, minWidth: 0 },
  retentionHeaderMainRtl: { alignItems: "flex-end" },
  retentionHeaderTitle: {
    fontSize: 11,
    fontWeight: "900",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  retentionHeaderSummary: {
    marginTop: theme.spacing.xs,
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.15,
  },
  retentionHeaderHint: {
    marginTop: theme.spacing.xs,
    fontSize: 12,
    color: theme.colors.textMuted,
    lineHeight: 17,
  },
  retentionChevron: {
    fontSize: 12,
    color: theme.colors.textSoft,
    marginTop: theme.spacing.xs,
  },
  retentionBody: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
  },
  retentionCaption: {
    fontSize: 13,
    color: theme.colors.textMuted,
    lineHeight: 19,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  retentionSaveBtn: { marginTop: theme.spacing.md },
  rtl: { textAlign: "right" },
  list: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  skeletonList: { marginTop: theme.spacing.md, gap: theme.spacing.sm },
  footerLoading: { marginVertical: theme.spacing.sm },
  card: {
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cardReverted: {
    opacity: 0.72,
    borderColor: theme.colors.borderMuted,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  cardHeaderRowRtl: { flexDirection: "row-reverse" },
  whenInHeader: { flex: 1, minWidth: 0 },
  cardHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    flexShrink: 0,
  },
  cardHeaderActionsRtl: { flexDirection: "row-reverse" },
  revertedBadge: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  revertedBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.2,
  },
  revertLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    minHeight: 34,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  revertLinkRtl: { flexDirection: "row-reverse" },
  revertLinkPressed: { opacity: 0.88, backgroundColor: theme.colors.accent },
  revertLinkDisabled: { opacity: 0.55 },
  revertIcon: {
    marginTop: 1,
  },
  revertLinkText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textMuted,
    letterSpacing: 0.15,
  },
  when: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.2,
  },
  event: {
    marginTop: theme.spacing.xs,
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.15,
    lineHeight: 22,
  },
  meta: { marginTop: theme.spacing.xs, fontSize: 12, fontWeight: "600", color: theme.colors.textMuted, letterSpacing: 0.15 },
  detailsBox: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  detailsTitle: {
    fontSize: 11,
    fontWeight: "900",
    color: theme.colors.textSoft,
    marginBottom: theme.spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  detailLine: {
    fontSize: 13,
    color: theme.colors.text,
    lineHeight: 20,
    marginBottom: theme.spacing.xs,
    fontWeight: "500",
    flexShrink: 1,
  },
  json: { marginTop: theme.spacing.sm, fontSize: 11, color: theme.colors.textMuted, fontFamily: undefined },
  listFooterWrap: { marginTop: theme.spacing.sm },
  paginationBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  paginationBarRtl: { flexDirection: "row-reverse" },
  paginationBtn: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  paginationBtnPressed: { opacity: 0.9 },
  paginationBtnDisabled: { opacity: 0.45 },
  paginationBtnText: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  paginationBtnTextDisabled: { color: theme.colors.textMuted },
  paginationSummary: {
    flex: 1,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
});
