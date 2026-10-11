import { useCallback, useEffect, useState } from "react";
import { FlatList, View, StyleSheet } from "react-native";
import { PressableScale } from "../../../src/components/PressableScale";
import { useFocusEffect, Stack, router } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";
import { useAppAlert } from "../../../src/context/AppAlertContext";
import { useToast } from "../../../src/context/ToastContext";
import { AppText } from "../../../src/components/AppText";
import { EmptyState } from "../../../src/components/EmptyState";
import { FlyOffRow } from "../../../src/components/FlyOffRow";
import { ListRowSkeleton } from "../../../src/components/ListRowSkeleton";
import { formatDateTimeForDisplay, formatISODateFull } from "../../../src/lib/dateFormat";
import { StatusChip } from "../../../src/components/StatusChip";
import { PrimaryButton } from "../../../src/components/PrimaryButton";
import { CrossfadeSwap } from "../../../src/components/CrossfadeSwap";
import { FadeSlideIn } from "../../../src/components/FadeSlideIn";
import { rowFlipFor } from "../../../src/lib/layoutDirection";
import { useScreenContentStyle } from "../../../src/hooks/useScreenLayout";

type Row = {
  user_id: string;
  username: string;
  full_name: string;
  phone: string;
  created_at: string | null;
  health_declaration_confirmed_at: string | null;
};

/** Local calendar date (YYYY-MM-DD) of a timestamp, for the signup date. */
function localISODate(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const UNDO_MS = 10000;

type HistoryItem = {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  athleteUserId: string | null;
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
  const screenContent = useScreenContentStyle("standard", { selfInset: theme.spacing.md });
  const titleFrame = useScreenContentStyle("standard", { scrolls: false });
  const { showOk, showConfirm } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [actorLabels, setActorLabels] = useState<Record<string, string>>({});
  const [historyLoading, setHistoryLoading] = useState(true);
  const [confirmingEmailId, setConfirmingEmailId] = useState<string | null>(null);
  // Phase 5 / U: the last decision can be taken back for a few seconds (same RPC, back to "pending").
  const [lastDecision, setLastDecision] = useState<{ row: Row; status: "approved" | "rejected" } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, full_name, phone, created_at, health_declaration_confirmed_at")
      .eq("role", "athlete")
      .eq("approval_status", "pending")
      .order("created_at", { ascending: true });
    setRows((data as Row[]) ?? []);
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from("user_activity_events")
      .select("id, created_at, actor_user_id, target_id, metadata")
      .eq("event_type", "athlete_approved")
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const items: HistoryItem[] = ((data as
      | {
          id: string;
          created_at: string;
          actor_user_id: string | null;
          target_id: string | null;
          metadata: Record<string, unknown> | null;
        }[]
      | null) ?? []).map((row) => {
      const meta = row.metadata ?? {};
      const fn = typeof meta.target_full_name === "string" ? meta.target_full_name.trim() : "";
      const un = typeof meta.target_username === "string" ? meta.target_username.trim() : "";
      return {
        id: row.id,
        createdAt: row.created_at,
        actorUserId: row.actor_user_id,
        athleteUserId: row.target_id || null,
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

  useEffect(() => {
    if (!lastDecision) return;
    const id = setTimeout(() => setLastDecision(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [lastDecision]);

  async function undoDecision() {
    if (!lastDecision || undoBusy) return;
    setUndoBusy(true);
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: lastDecision.row.user_id,
      p_status: "pending",
    });
    setUndoBusy(false);
    if (error || !data?.ok) {
      showOk(t("common.error"), error?.message ?? String(data?.error ?? ""));
      return;
    }
    setLastDecision(null);
    showToast({ message: t("approve.undone").replace("{name}", lastDecision.row.full_name), variant: "success" });
    load();
    void loadHistory();
  }

  async function setApproval(uid: string, status: "approved" | "rejected") {
    if (busyId) return;
    const row = rows.find((r) => r.user_id === uid);
    setBusyId(uid);
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: status,
    });
    if (error) {
      setBusyId(null);
      showOk(t("common.error"), error.message);
    } else if (data?.ok) {
      // Keep busyId set through the exit animation — onRowLeft clears it once the row's
      // actually gone, so the row can't be double-actioned while it's flying off.
      setLeavingId(uid);
      if (row) setLastDecision({ row, status });
    } else {
      setBusyId(null);
      showOk(t("common.failed"), data?.error ?? "");
    }
  }

  function onRowLeft(uid: string) {
    setLeavingId((cur) => (cur === uid ? null : cur));
    setBusyId(null);
    load();
    void loadHistory();
  }

  async function confirmEmailFor(uid: string | null) {
    if (!uid || confirmingEmailId) return;
    setConfirmingEmailId(uid);
    const { data, error } = await supabase.functions.invoke("staff-confirm-email", {
      body: { user_id: uid },
    });
    setConfirmingEmailId(null);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.ok) {
      showToast({ message: t("common.failed"), detail: String(data?.error ?? ""), variant: "error" });
      return;
    }
    showToast({ message: t("profile.emailConfirmed"), variant: "success" });
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
      <View style={titleFrame}>
        <AppText variant="headline" isRTL={isRTL} style={styles.title}>
          {t("approve.title")}
        </AppText>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={[styles.list, screenContent]}
        ListHeaderComponent={
          lastDecision ? (
            <View style={[styles.undoBar, rowFlipFor(isRTL) && styles.rowRtl]} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <AppText variant="label" isRTL={isRTL} style={styles.undoText} numberOfLines={2}>
                {t(lastDecision.status === "approved" ? "approve.approvedToast" : "approve.rejectedToast").replace(
                  "{name}",
                  lastDecision.row.full_name
                )}
              </AppText>
              <PrimaryButton label={t("attendance.undo")} onPress={() => void undoDecision()} loading={undoBusy} variant="ghost" size="compact" />
            </View>
          ) : null
        }
        ListEmptyComponent={<EmptyState title={t("approve.empty")} isRTL={isRTL} />}
        renderItem={({ item }) => (
          <FlyOffRow
            leaving={leavingId === item.user_id}
            isRTL={isRTL}
            style={styles.card}
            onDone={() => onRowLeft(item.user_id)}
          >
            {/* Phase 5 / U: who this is — name first, then contact, signup date and health declaration. */}
            <AppText variant="title" isRTL={isRTL}>
              {item.full_name || `@${item.username}`}
            </AppText>
            <AppText variant="secondary" isRTL={isRTL} style={styles.meta}>
              {[item.phone, item.username ? `@${item.username}` : ""].filter(Boolean).join(" · ")}
            </AppText>
            <View style={[styles.facts, rowFlipFor(isRTL) && styles.rowRtl]}>
              {item.created_at ? (
                <AppText variant="caption" muted isRTL={isRTL}>
                  {t("approve.signedUp").replace("{date}", formatISODateFull(localISODate(item.created_at), language))}
                </AppText>
              ) : null}
              <StatusChip
                label={t(item.health_declaration_confirmed_at ? "approve.healthSigned" : "approve.healthMissing")}
                tone={item.health_declaration_confirmed_at ? "success" : "warning"}
              />
            </View>
            <View style={[styles.actions, rowFlipFor(isRTL) && styles.rowRtl]}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${t("approve.approveBtn")}: ${item.full_name}`}
                style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => void setApproval(item.user_id, "approved")}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.okT}>
                  {busyId === item.user_id ? t("common.loading") : t("approve.approveBtn")}
                </AppText>
              </PressableScale>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${t("approve.rejectBtn")}: ${item.full_name}`}
                style={({ pressed }) => [styles.reject, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => confirmReject(item)}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.rejectT}>
                  {t("approve.rejectBtn")}
                </AppText>
              </PressableScale>
            </View>
          </FlyOffRow>
        )}
        ListFooterComponent={
          <View style={styles.historySection}>
            <AppText variant="title" isRTL={isRTL} style={styles.historyTitle}>
              {t("approve.historyTitle")}
            </AppText>
            <CrossfadeSwap
              loading={historyLoading}
              skeleton={
                <View style={styles.historySkeletonList}>
                  <ListRowSkeleton />
                  <ListRowSkeleton />
                </View>
              }
            >
              {history.length === 0 ? (
                <AppText variant="caption" muted isRTL={isRTL} style={styles.historyEmpty}>
                  {t("approve.historyEmpty")}
                </AppText>
              ) : (
                history.map((item, index) => (
                  <FadeSlideIn key={item.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
                    <View style={styles.historyCard}>
                      <View style={[styles.historyRowTop, rowFlipFor(isRTL) && styles.historyRowTopRtl]}>
                        <PressableScale
                          onPress={() => {
                            if (!item.athleteUserId) return;
                            router.push(`/(app)/staff/profile/${item.athleteUserId}` as never);
                          }}
                          disabled={!item.athleteUserId}
                          style={styles.historyNameBtn}
                          accessibilityRole="button"
                          accessibilityLabel={item.athleteName}
                        >
                          <AppText
                            variant="title"
                            isRTL={isRTL}
                            style={item.athleteUserId ? styles.historyNameLink : undefined}
                          >
                            {item.athleteName}
                          </AppText>
                        </PressableScale>
                        <PressableScale
                          onPress={() => void confirmEmailFor(item.athleteUserId)}
                          disabled={!item.athleteUserId || confirmingEmailId !== null}
                          style={[
                            styles.historyConfirmEmailBtn,
                            (!item.athleteUserId || confirmingEmailId === item.athleteUserId) && { opacity: 0.6 },
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={t("profile.confirmEmail")}
                        >
                          <AppText variant="label" style={styles.historyConfirmEmailTxt}>
                            {confirmingEmailId === item.athleteUserId ? t("common.loading") : t("profile.confirmEmail")}
                          </AppText>
                        </PressableScale>
                      </View>
                      <View style={[styles.historyMetaRow, rowFlipFor(isRTL) && styles.historyMetaRowRtl]}>
                        <AppText variant="caption" muted isRTL={isRTL} style={styles.historyMetaBy} numberOfLines={1}>
                          {t("approve.approvedByName").replace(
                            "{name}",
                            item.actorUserId ? actorLabels[item.actorUserId] ?? item.actorUserId : t("approve.unknownManager")
                          )}
                        </AppText>
                        <AppText variant="caption" style={styles.historyMetaDot}>
                          ·
                        </AppText>
                        <AppText variant="caption" muted isRTL={isRTL} style={styles.historyMetaWhen}>
                          {formatDateTimeForDisplay(item.createdAt, language)}
                        </AppText>
                      </View>
                    </View>
                  </FadeSlideIn>
                ))
              )}
            </CrossfadeSwap>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  title: { paddingVertical: theme.spacing.md },
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
  meta: { marginTop: 2, color: theme.colors.textMuted },
  facts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.md },
  // Approve is the neutral primary action (Phase 5 / U); Reject stays the outlined, confirmed one.
  ok: {
    flex: 1,
    backgroundColor: theme.colors.cta,
    minHeight: theme.controls.minTouch,
    justifyContent: "center",
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  okT: { color: theme.colors.ctaText },
  reject: {
    flex: 1,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    minHeight: theme.controls.minTouch,
    justifyContent: "center",
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  undoBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  undoText: { flex: 1, color: theme.colors.text },
  rejectT: { color: theme.colors.error },
  historySection: {
    marginTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  historyTitle: { marginBottom: theme.spacing.sm },
  historySkeletonList: { gap: theme.spacing.sm },
  historyEmpty: { paddingVertical: theme.spacing.sm },
  historyCard: {
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  historyRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  historyRowTopRtl: { flexDirection: "row-reverse" },
  historyNameBtn: { flexShrink: 1 },
  historyNameLink: { color: theme.colors.cta },
  historyConfirmEmailBtn: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.full,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  historyConfirmEmailTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 12, letterSpacing: 0.2 },
  historyMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.spacing.xs,
    gap: 4,
  },
  historyMetaRowRtl: { flexDirection: "row-reverse" },
  historyMetaBy: { flexShrink: 1 },
  historyMetaDot: { color: theme.colors.textSoft },
  historyMetaWhen: { flexShrink: 0 },
});
