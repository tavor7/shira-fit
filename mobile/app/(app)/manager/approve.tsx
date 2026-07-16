import { useCallback, useState } from "react";
import { FlatList, View, StyleSheet } from "react-native";
import { PressableScale } from "../../../src/components/PressableScale";
import { useFocusEffect, Stack } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";
import { useAppAlert } from "../../../src/context/AppAlertContext";
import { AppText } from "../../../src/components/AppText";
import { EmptyState } from "../../../src/components/EmptyState";
import { ListRowSkeleton } from "../../../src/components/ListRowSkeleton";
import { formatDateTimeForDisplay } from "../../../src/lib/dateFormat";

type Row = { user_id: string; username: string; full_name: string; phone: string };

type HistoryItem = {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  athleteName: string;
};

const HISTORY_LIMIT = 30;

async function fetchActorLabels(userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return {};
  const { data } = await supabase.from("profiles").select("user_id, full_name, username").in("user_id", unique);
  const out: Record<string, string> = {};
  for (const p of (data as { user_id: string; full_name: string | null; username: string | null }[]) ?? []) {
    const fn = (p.full_name ?? "").trim();
    const un = (p.username ?? "").trim();
    out[p.user_id] = fn ? (un ? `${fn} (@${un})` : fn) : un ? `@${un}` : p.user_id;
  }
  return out;
}

export default function ApproveAthletesScreen() {
  const { t, isRTL, language } = useI18n();
  const { showOk, showConfirm } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [actorLabels, setActorLabels] = useState<Record<string, string>>({});
  const [historyLoading, setHistoryLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, full_name, phone")
      .eq("role", "athlete")
      .eq("approval_status", "pending");
    setRows((data as Row[]) ?? []);
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from("user_activity_events")
      .select("id, created_at, actor_user_id, metadata")
      .eq("event_type", "athlete_approved")
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const items: HistoryItem[] = ((data as
      | { id: string; created_at: string; actor_user_id: string | null; metadata: Record<string, unknown> | null }[]
      | null) ?? []).map((row) => {
      const meta = row.metadata ?? {};
      const fn = typeof meta.target_full_name === "string" ? meta.target_full_name.trim() : "";
      const un = typeof meta.target_username === "string" ? meta.target_username.trim() : "";
      return {
        id: row.id,
        createdAt: row.created_at,
        actorUserId: row.actor_user_id,
        athleteName: fn || (un ? `@${un}` : t("approve.unknownAthlete")),
      };
    });
    setHistory(items);
    setActorLabels(await fetchActorLabels(items.map((i) => i.actorUserId ?? "").filter(Boolean)));
    setHistoryLoading(false);
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      load();
      void loadHistory();
    }, [load, loadHistory])
  );

  async function setApproval(uid: string, status: "approved" | "rejected") {
    if (busyId) return;
    setBusyId(uid);
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: status,
    });
    setBusyId(null);
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) {
      load();
      if (status === "approved") void loadHistory();
    } else showOk(t("common.failed"), data?.error ?? "");
  }

  function confirmReject(row: Row) {
    showConfirm({
      title: t("approve.rejectConfirmTitle"),
      message: t("approve.rejectConfirmMessage").replace("{name}", row.full_name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("approve.rejectBtn"),
      confirmVariant: "danger",
      onConfirm: () => void setApproval(row.user_id, "rejected"),
    });
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.managerApprove") }} />
      <AppText variant="headline" isRTL={isRTL} style={styles.title}>
        {t("approve.title")}
      </AppText>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<EmptyState title={t("approve.empty")} isRTL={isRTL} />}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <AppText variant="title">{item.full_name}</AppText>
            <AppText variant="caption" muted style={styles.meta}>
              {item.username} · {item.phone}
            </AppText>
            <View style={styles.actions}>
              <PressableScale
                style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => void setApproval(item.user_id, "approved")}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.okT}>
                  {busyId === item.user_id ? t("common.loading") : t("approve.approveBtn")}
                </AppText>
              </PressableScale>
              <PressableScale
                style={({ pressed }) => [styles.reject, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => confirmReject(item)}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.rejectT}>
                  {t("approve.rejectBtn")}
                </AppText>
              </PressableScale>
            </View>
          </View>
        )}
        ListFooterComponent={
          <View style={styles.historySection}>
            <AppText variant="title" isRTL={isRTL} style={styles.historyTitle}>
              {t("approve.historyTitle")}
            </AppText>
            {historyLoading ? (
              <View style={styles.historySkeletonList}>
                <ListRowSkeleton />
                <ListRowSkeleton />
              </View>
            ) : history.length === 0 ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.historyEmpty}>
                {t("approve.historyEmpty")}
              </AppText>
            ) : (
              history.map((item) => (
                <View key={item.id} style={styles.historyRow}>
                  <AppText variant="body">{item.athleteName}</AppText>
                  <AppText variant="caption" muted isRTL={isRTL} style={styles.historyMeta}>
                    {t("approve.approvedBy")
                      .replace("{name}", item.actorUserId ? actorLabels[item.actorUserId] ?? item.actorUserId : t("approve.unknownManager"))
                      .replace("{when}", formatDateTimeForDisplay(item.createdAt, language))}
                  </AppText>
                </View>
              ))
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  title: { padding: theme.spacing.md },
  list: { paddingBottom: theme.spacing.xl, flexGrow: 1 },
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  meta: { marginTop: theme.spacing.xs },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  ok: { flex: 1, backgroundColor: theme.colors.success, padding: theme.spacing.sm, borderRadius: theme.radius.md, alignItems: "center" },
  okT: { color: theme.colors.white },
  reject: {
    flex: 1,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  rejectT: { color: theme.colors.error },
  historySection: {
    marginTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  historyTitle: { marginBottom: theme.spacing.sm },
  historySkeletonList: { gap: theme.spacing.sm },
  historyEmpty: { paddingVertical: theme.spacing.sm },
  historyRow: {
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  historyMeta: { marginTop: 2 },
});
